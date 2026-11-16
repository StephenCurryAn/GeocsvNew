import { AnalysisError, AnalysisInputError } from '../../modules/analysis/errors';
import { listOperators } from '../../modules/operators/registry';
import type { DatasetSummary } from '../../modules/spatialPivot/datasets';
import type { SpatialPivotSpec } from '../../modules/spatialPivot/plan';

export interface DraftContext {
  userPrompt: string;
  datasets: DatasetSummary[];
  previousTargetId?: string;
  previousPivot?: SpatialPivotSpec | null;
  pivotOnly?: boolean;
}

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const unavailable = () => new AnalysisError(503, 'PLANNER_UNAVAILABLE',
  '模型规划暂不可用，请检查规划服务和模型配置，或使用空间透视表单。');
const timeout = () => new AnalysisError(504, 'PLANNER_TIMEOUT', '模型规划超时，请稍后重试或缩小图层范围。');
export const invalidDraft = () => new AnalysisError(502, 'PLANNER_INVALID_RESPONSE',
  '模型返回的计划无法通过校验，请明确图层、字段和参数后重试。');

export const isAgentConfigured = () => Boolean(process.env.AGENT_SERVICE_URL && process.env.AGENT_SERVICE_TOKEN);

export async function requestDraft(context: DraftContext): Promise<unknown> {
  const url = process.env.AGENT_SERVICE_URL;
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!url || !token) throw unavailable();

  const refs = new Map(context.datasets.map(({ fileId }, index) => [fileId, 'layer_' + (index + 1)]));
  const ids = new Map([...refs].map(([id, ref]) => [ref, id]));
  const operators = listOperators()
    .filter(operator => !context.pivotOnly || operator.id === 'spatial_pivot')
    .map(({ id, version, name, inputs }) => ({ id, version, name, inputs }));
  const previous = context.previousPivot;
  const target = previous && refs.get(previous.target.fileId);
  const join = previous && refs.get(previous.join.fileId);
  const body = {
    userPrompt: context.userPrompt,
    datasets: context.datasets.map(({ fileId, name, geometryTypes, fields, numericFields }) => ({
      ref: refs.get(fileId), name, geometryTypes,
      fields: fields.filter(field => field.length > 0 && field.length <= 255),
      numericFields: numericFields?.filter(field => field.length > 0 && field.length <= 255) ?? [],
    })),
    operators,
    previousTarget: context.previousTargetId && refs.get(context.previousTargetId),
    previousPivot: previous && target && join ? {
      ...previous, target: { ...previous.target, fileId: target }, join: { ...previous.join, fileId: join },
    } : undefined,
  };
  const signal = AbortSignal.timeout(32000);
  let response: Response;
  try {
    response = await fetch(new URL('/plan', url), {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  if (!record(result) || result.status !== 'ready' || !record(result.spec)) return result;
  const resolve = (value: unknown) => {
    if (!record(value) || typeof value.fileId !== 'string') throw invalidDraft();
    const fileId = ids.get(value.fileId);
    if (!fileId) throw new AnalysisInputError('模型引用了候选范围外的图层，请明确当前场景中的图层名称', 'DATASET_NOT_FOUND');
    return { ...value, fileId };
  };
  const spec = { ...result.spec, target: resolve(result.spec.target) };
  return { ...result, spec: 'join' in result.spec ? { ...spec, join: resolve(result.spec.join) } : spec };
}
