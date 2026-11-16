import { Router } from 'express';
import type { Pool } from 'pg';
import { requestDraft } from '../../integrations/agent/client';
import { sceneContainsFiles } from '../../models/Scene';
import { AnalysisInputError } from '../analysis/errors';
import { analysisRoute, uuid } from '../analysis/router';
import type { AnalysisService } from '../analysis/service';
import { explicitlyRequested, record, type OperatorDraftResult, type PlanningHistory } from '../operators/planning';
import { listRegisteredOperators } from '../operators/registry';
import { pivotPlanningHistory } from '../operators/spatialPivot';
import type { Operator } from '../operators/types';
import { readDataset } from '../spatialPivot/datasets';
import { parseSpatialPivotSpec, SPATIAL_PIVOT_OPERATOR } from '../spatialPivot/plan';
import { boundaryChoice, isUnclearChartFollowup, isViewOnly, requestedCharts, rulePlan, unsupportedRequirement } from './rules';
import { NaturalAnalysisPlanner, readNaturalRequest } from './service';
import { clarification, type NaturalPlan } from './types';

const sameLayer = (prompt: string) => /同一(?:个|张)?(?:图层|层)|上(?:一个|一条|次)(?:计划|分析)?(?:的)?图层|该图层|这个图层/.test(prompt);
const codeRequest = (prompt: string) => /\x60{3}|\bSELECT\s+[\s\S]+\s+FROM\b|(?:执行|运行|编写|生成|写一段)\s*(?:任意\s*)?(?:SQL|Python)\b/i.test(prompt);
export const createScenePlannerRouter = (
  db: Pool, service: AnalysisService, operators: readonly Operator[] = listRegisteredOperators(),
) => {
  const router = Router();
  router.post('/scenes/:sceneId/analysis/plans/natural-language', analysisRoute(service)(async (req, res) => {
    const reply = (data: unknown) => res.json({ code: 200, data });
    const sceneId = uuid(req.params.sceneId);
    if (!record(req.body)) throw new AnalysisInputError('请提供分析需求和所选图层');
    const { contextPlanId, ...input } = req.body;
    const { userPrompt, fileIds, contextRunId } = readNaturalRequest(input);
    const requestsOtherOperator = operators.some(operator =>
      operator.descriptor.id !== SPATIAL_PIVOT_OPERATOR.id && explicitlyRequested(userPrompt, operator));
    const scene = await db.query('SELECT 1 FROM scenes WHERE id = $1', [sceneId]);
    if (!scene.rowCount) throw new AnalysisInputError('当前场景不存在，请刷新场景列表', 'DATASET_NOT_FOUND');
    if (!await sceneContainsFiles(db, sceneId, fileIds)) {
      throw new AnalysisInputError('所选图层不属于当前场景', 'DATASET_NOT_FOUND');
    }
    if (codeRequest(userPrompt)) return reply({ status: 'unsupported', message: '请描述空间分析需求。规划助手支持目录中的分析方法。' });

    const run = contextRunId ? await service.get(uuid(contextRunId)) : null;
    const previousPivot = run?.status === 'succeeded' && run.operator.id === SPATIAL_PIVOT_OPERATOR.id
      && run.operator.version === SPATIAL_PIVOT_OPERATOR.version ? parseSpatialPivotSpec(run.spec) : undefined;
    const previousPivotIds = previousPivot ? [previousPivot.target.fileId, previousPivot.join.fileId] : [];
    const canReuse = previousPivot && await sceneContainsFiles(db, sceneId, previousPivotIds);
    const scopedPivot = canReuse ? previousPivot : undefined;
    const pivotPlanner = new NaturalAnalysisPlanner({
      readDataset: id => readDataset(db, id),
      validatePlan: async value => parseSpatialPivotSpec(value),
      getRun: async () => run && scopedPivot ? { ...run, spec: scopedPivot } : null,
    });
    if (isViewOnly(userPrompt) || requestedCharts(userPrompt).length > 1
      || (!requestsOtherOperator && scopedPivot && isUnclearChartFollowup(userPrompt))) {
      return reply(await pivotPlanner.plan({ userPrompt, fileIds, contextRunId }));
    }

    let history: PlanningHistory | undefined;
    if (contextPlanId !== undefined && sameLayer(userPrompt)) {
      const previous = await service.getPlan(uuid(contextPlanId));
      if (!previous || !await sceneContainsFiles(db, sceneId, Object.values(previous.inputVersions).map(item => item.fileId))) {
        return reply(clarification('当前场景中找不到上一份计划的图层，请指明要使用的图层。'));
      }
      history = { operator: previous.operator,
        fileIds: Object.fromEntries(Object.entries(previous.inputVersions).map(([role, item]) => [role, item.fileId])) };
    }
    const selected = fileIds.length ? fileIds : (await db.query<{ id: string }>(
      "SELECT id FROM file_nodes WHERE scene_id = $1 AND type = 'file' ORDER BY name, id LIMIT 31", [sceneId],
    )).rows.map(row => row.id);
    if (selected.length > 30) return reply(clarification('当前场景超过 30 个图层，请先勾选本次要分析的图层。'));
    const datasets = (await Promise.all(selected.map(id => readDataset(db, id, true))))
      .filter(item => item.geometryTypes.length && item.featureCount > 0);
    if (!datasets.length) return reply(clarification('请在当前场景上传或选择有空间要素的图层。'));
    const datasetIds = new Set(datasets.map(item => item.fileId));
    const allowedPreviousPivot = scopedPivot && previousPivotIds.every(id => datasetIds.has(id)) ? scopedPivot : undefined;
    const save = async (data: Extract<NaturalPlan | OperatorDraftResult, { status: 'ready' }>) =>
      reply({ ...data, confirmationStatus: 'pending_confirmation', plan: await service.createPlan(data.spec, sceneId) });

    if (!requestsOtherOperator) {
      const unsupported = unsupportedRequirement(userPrompt);
      const boundary = boundaryChoice(userPrompt);
      if (boundary === 'conflict') return reply(clarification('边界点同时被要求纳入和排除，请选择一种规则。'));
      if (!unsupported && (/统计|计数|数量|个数|多少|\bcount\b/i.test(userPrompt) || allowedPreviousPivot)) {
        const result = rulePlan(userPrompt, datasets, allowedPreviousPivot);
        if (result) return result.status === 'ready' ? await save(result) : reply(result);
      }
    }

    if (history && Object.values(history.fileIds).some(id => !datasetIds.has(id))) {
      return reply(clarification('上一份计划的图层不在本次候选范围内，请勾选该图层或指明新的图层。'));
    }
    const result = await requestDraft({
      userPrompt, datasets, hasSelection: fileIds.length > 0,
      history: history ?? (allowedPreviousPivot ? pivotPlanningHistory(allowedPreviousPivot) : undefined),
    }, operators);
    return result.status === 'ready' ? await save(result) : reply(result);
  }));
  return router;
};
