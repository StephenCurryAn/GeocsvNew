import { AnalysisInputError } from '../analysis/errors';
import type { OperatorParameterSchema } from '../analysis/protocol';

type ParameterValues<S extends OperatorParameterSchema> = {
  [K in keyof S['properties']]: S['properties'][K] extends { enum: readonly (infer V)[] } ? V : number;
};

export const hasKey = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

export function readOperatorParameters<S extends OperatorParameterSchema>(
  schema: S, input: Record<string, unknown>,
): ParameterValues<S> {
  for (const key of Object.keys(input)) {
    if (!hasKey(schema.properties, key)) {
      throw new AnalysisInputError('算子不支持参数 ' + key, 'INVALID_SPEC');
    }
  }
  const values = Object.entries(schema.properties).map(([key, definition]) => {
    const value = input[key] === undefined ? definition.default : input[key];
    const valid = definition.type === 'string'
      ? typeof value === 'string' && definition.enum.includes(value)
      : typeof value === 'number' && Number.isSafeInteger(value)
        && value >= definition.minimum && value <= definition.maximum;
    if (!valid) throw new AnalysisInputError('参数无效：' + definition.description, 'INVALID_SPEC');
    return [key, value] as const;
  });
  return Object.fromEntries(values) as ParameterValues<S>;
}
