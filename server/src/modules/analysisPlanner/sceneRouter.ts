import { Router } from 'express';
import type { Pool } from 'pg';
import { invalidDraft, record, requestDraft } from '../../integrations/agent/client';
import { sceneContainsFiles } from '../../models/Scene';
import { AnalysisInputError } from '../analysis/errors';
import { analysisRoute, uuid } from '../analysis/router';
import type { AnalysisService } from '../analysis/service';
import { parseMoranSpec, moranLisa } from '../operators/moranLisa';
import { requireOperator } from '../operators/registry';
import { readDataset, type DatasetSummary } from '../spatialPivot/datasets';
import { parseSpatialPivotSpec, SPATIAL_PIVOT_OPERATOR } from '../spatialPivot/plan';
import { boundaryChoice, isUnclearChartFollowup, isViewOnly, requestedCharts, rulePlan, unsupportedRequirement } from './rules';
import { NaturalAnalysisPlanner, readNaturalRequest } from './service';
import { clarification, type NaturalPlan } from './types';

const mentions = (prompt: string, name: string) => {
  const escaped = name.replace(/[.*+?{}$()|[\]\\]/g, '\\$&');
  return new RegExp('(?<![\\w.-])' + escaped + '(?![\\w.-])', 'i').test(prompt);
};

const named = (prompt: string, data: DatasetSummary[]) =>
  data.filter(({ name }) => mentions(prompt, name) || mentions(prompt, name.replace(/\.[^.]+$/, '')));

const fitsRole = (dataset: DatasetSummary, geometryTypes: readonly string[]) =>
  dataset.geometryTypes.length > 0 && dataset.geometryTypes.every(type => geometryTypes.includes(type));

const sameLayer = (prompt: string) => /同一(?:个|张)?(?:图层|层)|上(?:一个|一条|次)(?:计划|分析)?(?:的)?图层|该图层|这个图层/.test(prompt);
const codeRequest = (prompt: string) => /\x60{3}|\bSELECT\s+[\s\S]+\s+FROM\b|(?:执行|运行|编写|生成|写一段)\s*(?:任意\s*)?(?:SQL|Python)\b/i.test(prompt);
const number = '([+-]?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)';
const permutationsPattern = new RegExp(number + '\\s*次\\s*置换|置换(?:次数)?\\s*(?:为|是|[:：=])?\\s*' + number + '|'
  + number + '\\s+permutations\\b|\\bpermutations\\s*(?:[:=]\\s*)?' + number, 'gi');
const seedPattern = new RegExp('(?:随机种子|种子|\\bseed)\\s*(?:为|是|[:：=])?\\s*' + number, 'gi');

const matchesNumber = (prompt: string, pattern: RegExp, actual: number) =>
  [...prompt.matchAll(pattern)].every(match => Number(match.slice(1).find(value => value !== undefined)) === actual);

export const createScenePlannerRouter = (db: Pool, service: AnalysisService, draft = requestDraft) => {
  const router = Router();
  router.post('/scenes/:sceneId/analysis/plans/natural-language', analysisRoute(service)(async (req, res) => {
    const reply = (data: unknown) => res.json({ code: 200, data });
    const sceneId = uuid(req.params.sceneId);
    if (!record(req.body)) throw new AnalysisInputError('请提供分析需求和所选图层');
    const { contextPlanId, ...input } = req.body;
    const { userPrompt, fileIds, contextRunId } = readNaturalRequest(input);
    const mentionsMoran = /moran|lisa|莫兰|空间自相关|\bqueen\b|\brook\b/i.test(userPrompt);
    const scene = await db.query('SELECT 1 FROM scenes WHERE id = $1', [sceneId]);
    if (!scene.rowCount) throw new AnalysisInputError('当前场景不存在，请刷新场景列表', 'DATASET_NOT_FOUND');
    if (!await sceneContainsFiles(db, sceneId, fileIds)) {
      throw new AnalysisInputError('所选图层不属于当前场景', 'DATASET_NOT_FOUND');
    }
    if (codeRequest(userPrompt)) return reply({ status: 'unsupported', message: '空间分析助手支持空间透视和 Moran/LISA 参数规划。' });

    const run = contextRunId ? await service.get(uuid(contextRunId)) : null;
    const previousPivot = run?.status === 'succeeded' && run.operator.id === SPATIAL_PIVOT_OPERATOR.id
      && run.operator.version === SPATIAL_PIVOT_OPERATOR.version ? parseSpatialPivotSpec(run.spec) : undefined;
    const previousPivotIds = previousPivot ? [previousPivot.target.fileId, previousPivot.join.fileId] : [];
    const canReuse = previousPivot && await sceneContainsFiles(db, sceneId, previousPivotIds);
    const scopedPivot = canReuse ? previousPivot : undefined;
    const candidates = new Map<string, DatasetSummary>();
    const pivotPlanner = new NaturalAnalysisPlanner({
      async readDataset(id) {
        const candidate = candidates.get(id);
        if (!candidate) throw new AnalysisInputError('请选择当前场景的图层', 'DATASET_NOT_FOUND');
        return candidate;
      },
      validatePlan: async value => parseSpatialPivotSpec(value),
      getRun: async () => run && scopedPivot ? { ...run, spec: scopedPivot } : null,
    });
    if (isViewOnly(userPrompt) || requestedCharts(userPrompt).length > 1
      || (!mentionsMoran && scopedPivot && isUnclearChartFollowup(userPrompt))) {
      return reply(await pivotPlanner.plan({ userPrompt, fileIds, contextRunId }));
    }

    let previousTargetId: string | undefined;
    if (contextPlanId !== undefined && sameLayer(userPrompt)) {
      const previous = await service.getPlan(uuid(contextPlanId));
      if (!previous || !await sceneContainsFiles(db, sceneId, Object.values(previous.inputVersions).map(item => item.fileId))) {
        return reply(clarification('当前场景中找不到上一份计划的图层，请指明要使用的图层。'));
      }
      if (previous.operator.id === moranLisa.descriptor.id) previousTargetId = previous.inputVersions.target?.fileId;
    }
    const selected = fileIds.length ? fileIds : (await db.query<{ id: string }>(
      "SELECT id FROM file_nodes WHERE scene_id = $1 AND type = 'file' ORDER BY name, id LIMIT 31", [sceneId],
    )).rows.map(row => row.id);
    if (selected.length > 30) return reply(clarification('当前场景超过 30 个图层，请先勾选本次要分析的图层。'));
    const datasets = (await Promise.all(selected.map(id => readDataset(db, id, true))))
      .filter(item => item.geometryTypes.length && item.featureCount > 0);
    if (!datasets.length) return reply(clarification('请在当前场景上传或选择有空间要素的图层。'));
    datasets.forEach(item => candidates.set(item.fileId, item));
    const allowedPreviousPivot = scopedPivot && previousPivotIds.every(id => candidates.has(id)) ? scopedPivot : undefined;
    const save = async (data: Extract<NaturalPlan, { status: 'ready' }>) =>
      reply({ ...data, confirmationStatus: 'pending_confirmation', plan: await service.createPlan(data.spec, sceneId) });

    if (!mentionsMoran) {
      const unsupported = unsupportedRequirement(userPrompt);
      const boundary = boundaryChoice(userPrompt);
      if (boundary === 'conflict') return reply(clarification('边界点同时被要求纳入和排除，请选择一种规则。'));
      if (!unsupported && (/统计|计数|数量|个数|多少|\bcount\b/i.test(userPrompt) || allowedPreviousPivot)) {
        const result = rulePlan(userPrompt, datasets, allowedPreviousPivot);
        if (result) return result.status === 'ready' ? await save(result) : reply(result);
      }
    }

    if (previousTargetId && !candidates.has(previousTargetId)) {
      return reply(clarification('上一份计划的图层不在本次候选范围内，请勾选该图层或指明新的图层。'));
    }
    const proposal = await draft({ userPrompt, datasets, previousTargetId, previousPivot: allowedPreviousPivot });
    if (!record(proposal)) throw invalidDraft();
    if (proposal.status === 'clarification' && Object.keys(proposal).length === 2
      && Array.isArray(proposal.questions) && proposal.questions.length > 0 && proposal.questions.length <= 5
      && proposal.questions.every(item => typeof item === 'string' && item.trim() && item.length <= 500)) {
      return reply(clarification(...proposal.questions as string[]));
    }
    if (proposal.status === 'unsupported' && Object.keys(proposal).length === 2
      && typeof proposal.message === 'string' && proposal.message.trim() && proposal.message.length <= 1000) {
      return reply({ status: 'unsupported', message: proposal.message });
    }
    if (proposal.status !== 'ready') throw invalidDraft();
    const operator = requireOperator(proposal.spec);
    if (operator.descriptor.id === SPATIAL_PIVOT_OPERATOR.id) {
      const unsupported = unsupportedRequirement(userPrompt);
      if (unsupported || mentionsMoran) return reply({ status: 'unsupported', message: unsupported || '空间透视只支持面内点计数。' });
      const spec = parseSpatialPivotSpec(proposal.spec);
      for (const [datasetId, geometry] of [
        [spec.target.fileId, SPATIAL_PIVOT_OPERATOR.targetGeometry], [spec.join.fileId, SPATIAL_PIVOT_OPERATOR.joinGeometry],
      ] as const) {
        const eligible = datasets.filter(item => fitsRole(item, geometry));
        const explicit = named(userPrompt, eligible);
        const choices = explicit.length ? explicit : eligible;
        if (choices.length !== 1 || choices[0].fileId !== datasetId) {
          return reply(clarification('请明确空间透视使用的目标面图层和关联点图层。'));
        }
      }
      const result = await pivotPlanner.reviewProposal(proposal, datasets, userPrompt, allowedPreviousPivot);
      return result.status === 'ready' ? await save(result) : reply(result);
    }
    if (operator.descriptor.id !== moranLisa.descriptor.id || Object.keys(proposal).length !== 2) throw invalidDraft();
    const spec = parseMoranSpec(proposal.spec);
    const target = candidates.get(spec.target.fileId);
    if (!target) throw new AnalysisInputError('模型引用了候选范围外的图层', 'DATASET_NOT_FOUND');
    const eligible = datasets.filter(item => fitsRole(item, moranLisa.descriptor.inputs.target.geometryTypes));
    const explicitLayers = named(userPrompt, datasets);
    const choices = explicitLayers.length ? explicitLayers
      : previousTargetId ? eligible.filter(item => item.fileId === previousTargetId) : fileIds.length ? eligible : [];
    if (choices.length !== 1 || choices[0].fileId !== target.fileId) {
      return reply(clarification('请指明一个面图层的名称或只勾选要分析的面图层。'));
    }
    const numericFields = target.numericFields ?? [];
    const fieldList = numericFields.join('、').slice(0, 450);
    if (!numericFields.includes(spec.target.valueField)) {
      return reply(clarification('请选择该图层中的有效数值字段。', ...(fieldList ? ['可用字段：' + fieldList] : [])));
    }
    const explicitFields = target.fields.filter(field => field && mentions(userPrompt, field));
    if (explicitFields.length > 1 || (explicitFields.length === 1 && explicitFields[0] !== spec.target.valueField)
      || (!explicitFields.length && numericFields.length > 1)) {
      return reply(clarification('请在需求中指明一个数值字段：' + fieldList));
    }
    const queen = /\bqueen\b/i.test(userPrompt);
    const rook = /\brook\b/i.test(userPrompt);
    const contiguity = queen || rook ? (queen ? 'queen' : 'rook') : /共点/.test(userPrompt) ? 'queen'
      : /共边/.test(userPrompt) ? 'rook' : undefined;
    if ((queen && rook) || (contiguity && contiguity !== spec.contiguity)
      || !matchesNumber(userPrompt, permutationsPattern, spec.permutations) || !matchesNumber(userPrompt, seedPattern, spec.seed)) {
      return reply(clarification('请确认唯一的 Queen 或 Rook 邻接规则、0–9999 次置换和有效的随机种子。'));
    }
    const plan = await service.createPlan(spec, sceneId);
    return reply({
      status: 'ready', source: 'llm', confirmationStatus: 'pending_confirmation',
      message: 'Moran/LISA 空间自相关', spec, plan, inputs: { targetName: target.name },
    });
  }));
  return router;
};
