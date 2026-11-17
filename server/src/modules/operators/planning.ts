import { AnalysisInputError } from '../analysis/errors';
import type { AnalysisSpec, OperatorInput, OperatorRef } from '../analysis/protocol';
import type { AnalysisView } from '../analysisPlanner/types';
import type { DatasetSummary } from '../spatialPivot/datasets';
import { hasKey } from './parameters';
import type { Operator } from './types';

export interface PlanningHistory {
  operator: OperatorRef;
  fileIds: Record<string, string>;
  parameters?: Record<string, string | number>;
}

export interface DraftContext {
  userPrompt: string;
  datasets: DatasetSummary[];
  hasSelection?: boolean;
  history?: PlanningHistory;
}

export interface OperatorDraftContext extends DraftContext {
  inputs: Record<string, { dataset: DatasetSummary; fields: Record<string, string> }>;
  parameters: Record<string, unknown>;
}

export type OperatorDraftResult =
  | { status: 'ready'; source: 'llm'; message: string; spec: AnalysisSpec;
      inputs: { targetName: string; joinName?: string; metricLabel?: string; dataMonth?: string }; view?: AnalysisView; assumptions?: string[] }
  | { status: 'clarification'; message: string; questions: string[] }
  | { status: 'unsupported'; message: string };

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function mentions(prompt: string, name: string) {
  const escaped = name.replace(/[.*+?{}$()|[\]\\]/g, '\\$&');
  return Boolean(escaped) && new RegExp('(?<![\\w.-])' + escaped + '(?![\\w.-])', 'i').test(prompt);
}

export const namedDatasets = (prompt: string, datasets: DatasetSummary[]) =>
  datasets.filter(({ name }) => mentions(prompt, name) || mentions(prompt, name.replace(/\.[^.]+$/, '')));

export const sameOperator = (left: OperatorRef, right: OperatorRef) =>
  left.id === right.id && left.version === right.version;

export const explicitlyRequested = (prompt: string, operator: Operator) =>
  [operator.descriptor.id, operator.descriptor.name, ...operator.descriptor.aliases].some(alias => mentions(prompt, alias));

const fieldsOf = (dataset: DatasetSummary, type: 'any' | 'numeric') =>
  type === 'numeric' ? dataset.numericFields ?? [] : dataset.fields;

export const fitsInput = (dataset: DatasetSummary, input: OperatorInput) =>
  dataset.geometryTypes.length > 0 && dataset.geometryTypes.every(type => input.geometryTypes.includes(type))
  && Object.values(input.fields ?? {}).every(field => !field.required || fieldsOf(dataset, field.type).length > 0);

export function resolveDraftInputs(
  definitions: Record<string, OperatorInput>, input: unknown,
  datasetsByRef: ReadonlyMap<string, DatasetSummary>,
) {
  if (!record(input) || Object.keys(input).some(role => !hasKey(definitions, role))) {
    throw new AnalysisInputError('草案包含未知输入角色', 'INVALID_SPEC');
  }
  return Object.fromEntries(Object.entries(definitions).map(([role, definition]) => {
    const binding = input[role];
    if (!record(binding) || typeof binding.ref !== 'string' || !record(binding.fields)
      || Object.keys(binding).length !== 2) {
      throw new AnalysisInputError('请为每个输入角色提供图层引用和字段', 'INVALID_SPEC');
    }
    const dataset = datasetsByRef.get(binding.ref);
    if (!dataset) throw new AnalysisInputError('模型引用了候选范围外的图层', 'DATASET_NOT_FOUND');
    if (!fitsInput(dataset, definition)) throw new AnalysisInputError('方案引用的图层不符合输入角色要求', 'INVALID_GEOMETRY');
    const fields = definition.fields ?? {};
    const selections = binding.fields;
    if (Object.keys(selections).some(key => !hasKey(fields, key))) {
      throw new AnalysisInputError('草案包含未知字段角色', 'INVALID_SPEC');
    }
    for (const [key, field] of Object.entries(fields)) {
      if (!hasKey(selections, key) && !field.required) continue;
      const value = selections[key];
      if (typeof value !== 'string' || !fieldsOf(dataset, field.type).includes(value)) {
        throw new AnalysisInputError('请从 ' + dataset.name + ' 选择有效字段：' + field.description, 'UNKNOWN_FIELD');
      }
    }
    return [role, { dataset, fields: selections as Record<string, string> }];
  }));
}
