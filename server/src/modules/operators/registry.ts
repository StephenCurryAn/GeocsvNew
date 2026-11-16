import { AnalysisInputError } from '../analysis/errors';
import { spatialPivot } from './spatialPivot';
import type { Operator } from './types';

const operatorKey = (id: string, version: number) => `${id}@${version}`;
const entries = [spatialPivot];
const registry = new Map<string, Operator>(
  entries.map(operator => [operatorKey(operator.descriptor.id, operator.descriptor.version), operator]),
);

export const listOperators = () => entries.map(entry => entry.descriptor);

export const requireOperator = (input: unknown): Operator => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AnalysisInputError('分析计划必须是对象', 'INVALID_SPEC');
  const { kind, operatorVersion } = input as { kind?: unknown; operatorVersion?: unknown };
  if (typeof kind === 'string' && typeof operatorVersion === 'number') {
    const operator = registry.get(operatorKey(kind, operatorVersion));
    if (operator) return operator;
  }
  throw new AnalysisInputError('不支持的分析算子或算子版本', 'UNSUPPORTED_OPERATOR');
};
