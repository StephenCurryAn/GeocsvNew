import { AnalysisInputError, parseSpatialPivotSpec, type SpatialPivotSpec } from '../spatialPivot/plan';
import type { DatasetSummary } from '../spatialPivot/datasets';
import { boundaryChoice, isUnclearChartFollowup, isViewOnly, requestedCharts, requestedLabel, rulePlan, unsupportedRequirement } from './rules';
import { clarification, type AnalysisView, type NaturalPlan, type PlannerDependencies } from './types';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const questions = (value: unknown): string[] | null => Array.isArray(value) && value.length > 0 && value.length <= 5
  && value.every(item => typeof item === 'string' && item.trim() && item.length <= 500) ? value : null;

const validView = (value: unknown): value is AnalysisView => object(value)
  && Object.keys(value).length === 1 && typeof value.chartType === 'string' && ['bar', 'line', 'pie'].includes(value.chartType);

export const readNaturalRequest = (input: unknown) => {
  if (!object(input) || typeof input.userPrompt !== 'string' || !input.userPrompt.trim() || input.userPrompt.length > 4000) {
    throw new AnalysisInputError('请提供 1 到 4000 字的分析需求');
  }
  if (Object.keys(input).some(key => !['userPrompt', 'fileIds', 'contextRunId'].includes(key))) {
    throw new AnalysisInputError('自然语言规划只接受需求、图层 ID 和历史执行 ID');
  }
  if (!Array.isArray(input.fileIds) || input.fileIds.length > 30
    || input.fileIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 255 || id.includes('\0'))) {
    throw new AnalysisInputError('请选择最多 30 个有效图层');
  }
  if (input.contextRunId !== undefined && (typeof input.contextRunId !== 'string'
    || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.contextRunId))) {
    throw new AnalysisInputError('历史执行 ID 无效');
  }
  return { userPrompt: input.userPrompt.trim(), fileIds: [...new Set(input.fileIds as string[])],
    contextRunId: input.contextRunId as string | undefined };
};

export class NaturalAnalysisPlanner {
  constructor(private readonly dependencies: PlannerDependencies) {}

  async plan(input: unknown): Promise<NaturalPlan> {
    const { userPrompt: prompt, fileIds, contextRunId } = readNaturalRequest(input);
    const chartTypes = requestedCharts(prompt);
    if (chartTypes.length > 1) return clarification('一次请选择一种图表：柱状图、折线图或饼图。');
    const context = contextRunId ? await this.dependencies.getRun(contextRunId) : null;
    if (contextRunId && !context) return clarification('找不到上一条执行记录，请从历史中重新选择。');
    if (isViewOnly(prompt)) {
      if (!context || context.status !== 'succeeded' || !context.artifactId) {
        return clarification('请先完成一次分析，再指定要复用的结果。');
      }
      return {
        status: 'view_only', message: '复用已保存的分析结果，只更改图表，不重新计算。',
        runId: context.id, artifactId: context.artifactId, view: { chartType: chartTypes[0] },
      };
    }
    if (context && isUnclearChartFollowup(prompt)) {
      return clarification('请明确是只更换已有结果的图表，还是需要修改计算条件；当前不会重新计算。');
    }
    const previous = context?.status === 'succeeded'
      && (fileIds.length === 0 || [context.spec.target.fileId, context.spec.join.fileId].every(id => fileIds.includes(id)))
      ? context.spec : undefined;
    const ids = fileIds.length ? fileIds : previous ? [previous.target.fileId, previous.join.fileId] : [];
    if (!ids.length) return clarification('请先选择一个目标面图层和一个关联点图层。');
    const datasets = await Promise.all(ids.map(id => this.dependencies.readDataset(id)));
    const unsupported = unsupportedRequirement(prompt);
    if (unsupported) return { status: 'unsupported', message: unsupported };
    const boundary = boundaryChoice(prompt);
    if (boundary === 'conflict') return clarification('边界点同时被要求纳入和排除，请选择一种规则。');
    const deterministic = rulePlan(prompt, datasets, previous);
    if (deterministic) {
      if (deterministic.status === 'ready') {
        deterministic.spec = await this.dependencies.validatePlan(deterministic.spec);
      }
      return deterministic;
    }
    if (!this.dependencies.complete) return {
      status: 'unsupported',
      message: '当前表述无法完整映射为已验证算子，且未配置模型解析。可明确写成“统计每个面内点的数量，按类型分类”，或使用分析表单。',
    };
    let proposal: unknown;
    try {
      proposal = await this.dependencies.complete({ userPrompt: prompt, datasets, previousSpec: previous || null });
    } catch {
      return clarification('模型解析暂不可用，请稍后重试，或改用明确的面内计数表述与分析表单。未提交任何计算。');
    }
    return this.reviewProposal(proposal, datasets, prompt, previous);
  }

  async reviewProposal(proposal: unknown, datasets: DatasetSummary[], prompt: string, previous?: SpatialPivotSpec): Promise<NaturalPlan> {
    if (!object(proposal)) return clarification('模型没有返回有效的结构化计划，请补充具体图层、字段与计算方法。');
    if (proposal.status === 'clarification') {
      const valid = questions(proposal.questions);
      return valid ? clarification(...valid) : clarification('模型未能明确理解需求，请补充具体图层和统计字段。');
    }
    if (proposal.status === 'unsupported') return {
      status: 'unsupported', message: typeof proposal.message === 'string' && proposal.message.trim()
        ? proposal.message.slice(0, 1000) : '需求超出当前已验证算子的能力。',
    };
    if (proposal.status !== 'ready' || Object.keys(proposal).some(key => !['status', 'spec', 'view', 'unsupportedRequirements'].includes(key))
      || !Array.isArray(proposal.unsupportedRequirements) || proposal.unsupportedRequirements.length > 0) {
      return { status: 'unsupported', message: '模型计划包含不受支持的算子、附加条件或输出，未提交计算。' };
    }
    if (!validView(proposal.view)) return clarification('模型返回了不支持的图表，请选择柱状图、折线图或饼图。');
    const chart = requestedCharts(prompt)[0];
    if (chart && proposal.view.chartType !== chart) return clarification('模型返回的图表与需求不一致，请明确展示类型。');
    let spec: SpatialPivotSpec;
    try { spec = parseSpatialPivotSpec(proposal.spec); }
    catch { return { status: 'unsupported', message: '模型计划不符合已验证算子的参数与版本要求，未执行生成代码。' }; }
    const target = datasets.find(dataset => dataset.fileId === spec.target.fileId);
    const join = datasets.find(dataset => dataset.fileId === spec.join.fileId);
    if (!target || !join) return clarification('模型引用了未选择的数据集，请明确目标面和关联点图层。');
    if (spec.target.labelField !== null && !target.fields.includes(spec.target.labelField)
      || spec.join.categoryField !== null && !join.fields.includes(spec.join.categoryField)) {
      return clarification('模型引用了不存在的字段，请使用图层中的真实字段名。');
    }
    const requestsClassification = /不同(?:类型|类别)|按(?:照)?.+(?:分类|分组)|按(?:类型|类别)|分类统计|\bby\b/i.test(prompt);
    if (requestsClassification && spec.join.categoryField === null) {
      return clarification('需求要求按类别拆分，但模型未指定分类字段，请明确字段。');
    }
    if (/不分类|不分组|不按.+分类|只统计总数|仅统计总数/.test(prompt) && spec.join.categoryField !== null) {
      return clarification('需求要求统计总数，但模型增加了分类维度，请确认分析条件。');
    }
    const explicitFields = join.fields.filter(field => field.length > 1 && prompt.includes(field));
    if (requestsClassification && explicitFields.length === 1 && spec.join.categoryField !== explicitFields[0]) {
      return clarification('模型返回的分类字段与需求不一致，请确认真实字段。');
    }
    const explicitBoundary = boundaryChoice(prompt);
    if (spec.boundaryPolicy !== (explicitBoundary || previous?.boundaryPolicy || 'exclude')) {
      return clarification('模型返回的边界规则与需求不一致，请明确是否纳入边界点。');
    }
    const explicitLabel = requestedLabel(prompt);
    if (explicitLabel && spec.target.labelField !== explicitLabel.field) {
      return clarification('模型返回的目标标识字段与需求不一致，请确认标签字段。');
    }
    try { spec = await this.dependencies.validatePlan(spec); }
    catch (error) {
      if (!(error instanceof AnalysisInputError)) throw error;
      return clarification(error.message);
    }
    return {
      status: 'ready', source: 'llm', message: '模型草案已通过已验证算子的协议与数据校验，请审阅后执行。',
      spec, view: proposal.view, inputs: { targetName: target.name, joinName: join.name },
      assumptions: [
        '每个目标要素单独计数，同名目标不合并；重叠面多重归属；无匹配目标保留为 0。',
        `边界点${spec.boundaryPolicy === 'exclude' ? '排除' : '纳入'}；本次仅执行计数，不进行筛选或额外聚合。`,
      ],
    };
  }
}
