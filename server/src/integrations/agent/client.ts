import { AnalysisError, AnalysisInputError } from '../../modules/analysis/errors';
import { fieldLabel } from '../../modules/analysisPlanner/sceneDataMeaning';
import { clarification } from '../../modules/analysisPlanner/types';
import { explicitlyRequested, fitsInput, record, resolveDraftInputs, sameOperator,
  type DraftContext, type OperatorDraftResult } from '../../modules/operators/planning';
import type { Operator } from '../../modules/operators/types';

const unavailable = () => new AnalysisError(503, 'PLANNER_UNAVAILABLE',
  '模型规划暂不可用，请检查规划服务和模型配置，或使用空间透视表单。');
const timeout = () => new AnalysisError(504, 'PLANNER_TIMEOUT', '模型规划超时，请稍后重试或缩小图层范围。');
export const invalidDraft = () => new AnalysisError(502, 'PLANNER_INVALID_RESPONSE',
  '模型返回的计划无法通过校验，请明确图层、字段和参数后重试。');

export const isAgentConfigured = () => Boolean(process.env.AGENT_SERVICE_URL && process.env.AGENT_SERVICE_TOKEN);

export async function requestDraft(context: DraftContext, registered: readonly Operator[]): Promise<OperatorDraftResult> {
  const named = registered.filter(operator => explicitlyRequested(context.userPrompt, operator));
  const namedIds = new Set(named.map(operator => operator.descriptor.id));
  if (namedIds.size > 1) return clarification('请一次选择一个分析方法。');
  const versions = [...context.userPrompt.normalize('NFKC').matchAll(
    /\b([a-z][a-z0-9_]*?)@(\d+)|(?:算子)?版本\s*(?:为|是|[:=])?\s*(\d+)/gi,
  )].flatMap(match => !match[1] || namedIds.has(match[1].toLowerCase()) ? [Number(match[2] ?? match[3])] : []);
  const selectable = named.length ? named.filter(operator => versions.every(version => version === operator.descriptor.version))
    : registered;
  if (named.length && !selectable.length) {
    return { status: 'unsupported', message: '当前目录没有指定的算子版本。' };
  }
  const candidates = selectable.map(operator => ({
    operator,
    inputs: Object.fromEntries(Object.entries(operator.descriptor.inputs).map(([role, input]) =>
      [role, context.datasets.filter(dataset => fitsInput(dataset, input))])),
  }));
  const available = candidates.filter(candidate => Object.values(candidate.inputs).every(datasets => datasets.length > 0));
  if (named.length && available.length !== candidates.length) {
    const missing = candidates.find(candidate => !available.includes(candidate))!;
    const roles = Object.keys(missing.inputs).filter(role => !missing.inputs[role].length);
    const details = roles.map(role => {
      const input = missing.operator.descriptor.inputs[role];
      const fields = Object.values(input.fields ?? {}).filter(field => field.required).map(field => field.description);
      return input.geometryTypes.join('/') + (fields.length ? '，含' + fields.join('、') : '');
    });
    return clarification('请在当前场景为「' + missing.operator.descriptor.name + '」选择匹配图层：' + details.join('；'));
  }
  if (!available.length) return clarification('请在当前场景选择符合分析要求的图层和字段。');

  const url = process.env.AGENT_SERVICE_URL;
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!url || !token) throw unavailable();

  const used = new Set(available.flatMap(candidate => Object.values(candidate.inputs).flat().map(dataset => dataset.fileId)));
  const datasets = context.datasets.filter(dataset => used.has(dataset.fileId));
  const refs = new Map(datasets.map(({ fileId }, index) => [fileId, 'layer_' + (index + 1)]));
  const operators = available.map(({ operator, inputs }) => {
    const { id, version, name, aliases, description, inputs: roles, parameterSchema, planningParameters } = operator.descriptor;
    return { id, version, name, aliases, description, inputs: roles, parameterSchema, planningParameters,
      eligibleRefs: Object.fromEntries(Object.entries(inputs).map(([role, layers]) =>
        [role, layers.map(layer => refs.get(layer.fileId))])) };
  });
  const history = context.history;
  const priorInputs = history && available.some(({ operator }) => sameOperator(operator.descriptor, history.operator))
    && Object.values(history.fileIds).every(id => refs.has(id))
    ? Object.fromEntries(Object.entries(history.fileIds).map(([role, id]) => [role, refs.get(id)])) : undefined;
  const body = {
    userPrompt: context.userPrompt,
    datasets: datasets.map(({ fileId, name, geometryTypes, fields, numericFields, dataMonth }) => ({
      ref: refs.get(fileId), name, geometryTypes,
      fields: fields.filter(field => field.length > 0 && field.length <= 255),
      numericFields: numericFields?.filter(field => field.length > 0 && field.length <= 255) ?? [],
      ...(dataMonth ? { dataMonth } : {}),
      ...(numericFields?.some(field => fieldLabel(field) !== field) ? {
        fieldLabels: Object.fromEntries(numericFields.filter(field => fieldLabel(field) !== field)
          .map(field => [field, fieldLabel(field)])),
      } : {}),
    })),
    operators,
    history: history && priorInputs ? { operator: history.operator, inputs: priorInputs, parameters: history.parameters } : undefined,
  };
  const payload = JSON.stringify(body);
  if (operators.length > 30 || Buffer.byteLength(payload) > 64 * 1024) {
    return clarification('候选图层或算子过多，请勾选本次要用的图层并指明分析方法。');
  }
  const signal = AbortSignal.timeout(32000);
  let response: Response;
  try {
    response = await fetch(new URL('/plan', url), {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: payload,
    });
  } catch {
    throw signal.aborted ? timeout() : unavailable();
  }
  if (response.status === 504) throw timeout();
  if (response.status === 429) throw new AnalysisError(429, 'PLANNER_RATE_LIMITED', '模型请求已达限额，请稍后重试。');
  let result: unknown;
  try { result = await response.json(); }
  catch { throw signal.aborted ? timeout() : invalidDraft(); }
  if (!response.ok) {
    if (record(result) && result.detail === 'model_invalid_response') throw invalidDraft();
    throw unavailable();
  }
  if (!record(result)) throw invalidDraft();
  if (result.status === 'clarification' && Object.keys(result).length === 2
    && Array.isArray(result.questions) && result.questions.length > 0 && result.questions.length <= 5
    && result.questions.every(item => typeof item === 'string' && item.trim() && item.length <= 500)) {
    return clarification(...result.questions);
  }
  if (result.status === 'unsupported' && Object.keys(result).length === 2
    && typeof result.message === 'string' && result.message.trim() && result.message.length <= 1000) {
    return { status: 'unsupported', message: result.message };
  }
  if (result.status !== 'ready' || Object.keys(result).length !== 4 || !record(result.operator)
    || Object.keys(result.operator).length !== 2 || typeof result.operator.id !== 'string'
    || typeof result.operator.version !== 'number' || !record(result.parameters)) throw invalidDraft();
  const ref = { id: result.operator.id, version: result.operator.version };
  const selected = available.find(({ operator }) => sameOperator(operator.descriptor, ref));
  if (!selected) throw new AnalysisInputError('模型选择了候选范围外的算子或版本', 'UNSUPPORTED_OPERATOR');
  const datasetsByRef = new Map(datasets.map(dataset => [refs.get(dataset.fileId)!, dataset]));
  try {
    const inputs = resolveDraftInputs(selected.operator.descriptor.inputs, result.inputs, datasetsByRef);
    return await selected.operator.planDraft({ ...context, inputs, parameters: result.parameters });
  } catch (error) {
    if (error instanceof AnalysisInputError && error.errorCode === 'UNKNOWN_FIELD') return clarification(error.message);
    throw error;
  }
}
