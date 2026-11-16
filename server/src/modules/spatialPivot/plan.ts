import { AnalysisInputError } from '../analysis/errors';
import type { OperatorParameterSchema } from '../analysis/protocol';
import { readOperatorParameters } from '../operators/parameters';
export { AnalysisInputError } from '../analysis/errors';

export interface SpatialPivotSpec {
  schemaVersion: 1;
  kind: 'spatial_pivot';
  operatorVersion: 1;
  target: { fileId: string; labelField: string | null };
  join: { fileId: string; categoryField: string | null };
  boundaryPolicy: 'include' | 'exclude';
}

export const SPATIAL_PIVOT_OPERATOR = Object.freeze({
  id: 'spatial_pivot', version: 1, name: '行政区内分类 POI 统计',
  targetGeometry: ['ST_Polygon', 'ST_MultiPolygon'],
  joinGeometry: ['ST_Point', 'ST_MultiPoint'],
});

export const SPATIAL_PIVOT_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    boundaryPolicy: { type: 'string', enum: ['exclude', 'include'], default: 'exclude',
      description: '是否计入边界点。exclude 排除，include 纳入' },
    chartType: { type: 'string', enum: ['bar', 'line', 'pie'], default: 'bar', description: '柱状图、折线图或饼图' },
  },
} as const satisfies OperatorParameterSchema;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalysisInputError('分析计划必须是对象', 'INVALID_SPEC');
  }
  return value as Record<string, unknown>;
};

const checkKeys = (input: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new AnalysisInputError('分析计划包含此版本不支持的参数', 'INVALID_SPEC');
  }
};

const text = (value: unknown, name: string, optional = false): string | null => {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || value.includes('\0')) {
    throw new AnalysisInputError(`${name}无效`, 'INVALID_SPEC');
  }
  // Preserve exact field names, including spaces and quotes.
  return value;
};

export const parseSpatialPivotSpec = (value: unknown): SpatialPivotSpec => {
  const input = record(value);
  const target = record(input.target);
  const join = record(input.join);
  checkKeys(input, ['schemaVersion', 'kind', 'operatorVersion', 'target', 'join', 'boundaryPolicy']);
  checkKeys(target, ['fileId', 'labelField']);
  checkKeys(join, ['fileId', 'categoryField']);
  if (input.schemaVersion !== 1 || input.kind !== 'spatial_pivot' || input.operatorVersion !== 1) {
    throw new AnalysisInputError('不支持的分析协议或算子版本', 'INVALID_SPEC');
  }
  if (input.boundaryPolicy === undefined) throw new AnalysisInputError('必须明确边界点是否计入', 'INVALID_SPEC');
  const { boundaryPolicy } = readOperatorParameters(SPATIAL_PIVOT_PARAMETERS, { boundaryPolicy: input.boundaryPolicy });
  const spec: SpatialPivotSpec = {
    schemaVersion: 1, kind: 'spatial_pivot', operatorVersion: 1,
    target: { fileId: text(target.fileId, '目标图层')!, labelField: text(target.labelField, '目标标签字段', true) },
    join: { fileId: text(join.fileId, '关联图层')!, categoryField: text(join.categoryField, '分类字段', true) },
    boundaryPolicy,
  };
  if (spec.target.fileId === spec.join.fileId) throw new AnalysisInputError('目标与 POI 必须是不同图层', 'INVALID_SPEC');
  return spec;
};

// Bound JSONB keys are values, never SQL identifiers. Geometry predicates are whitelisted.
export const buildSpatialPivotQuery = (spec: SpatialPivotSpec) => ({
  text: `
    SELECT t.id AS feature_id,
           COALESCE(t.properties ->> $3::text, t.id::text) AS label,
           CASE WHEN $4::text IS NULL THEN NULL ELSE p.properties ->> $4::text END AS category,
           COUNT(DISTINCT p.id)::integer AS count
    FROM spatial_features t
    LEFT JOIN spatial_features p
      ON p.file_id = $2 AND t.geom && p.geom
     AND ${spec.boundaryPolicy === 'include' ? 'ST_Covers' : 'ST_ContainsProperly'}(t.geom, p.geom)
    WHERE t.file_id = $1
    GROUP BY t.id, label, category
    ORDER BY t.id, category NULLS FIRST`,
  values: [spec.target.fileId, spec.join.fileId, spec.target.labelField, spec.join.categoryField],
});

export interface SpatialCount { feature_id: number; label: string; category: string | null; count: number }

export const formatSpatialCounts = (counts: SpatialCount[], categorized: boolean) => {
  const categories = categorized
    ? [...new Set(counts.filter(row => row.count > 0).map(row => row.category))]
        .sort((a, b) => a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0)
    : [null];
  const literalLabels = new Set(categories.filter((category): category is string => category !== null && category !== ''));
  const uniqueLabel = (base: string) => {
    let label = base;
    let suffix = 2;
    while (literalLabels.has(label)) label = `${base} ${suffix++}`;
    literalLabels.add(label);
    return label;
  };
  const missingLabel = uniqueLabel('未分类（空值）');
  const emptyLabel = uniqueLabel('空字符串');
  const columns = categories.map((category, index) => ({
    key: `c${index}`, label: categorized ? category === null ? missingLabel : category === '' ? emptyLabel : category : '数量',
  }));
  const keys = new Map(categories.map((category, index) => [category, `c${index}`]));
  const rows = new Map<number, { featureId: number; label: string; counts: Record<string, number>; total: number }>();
  for (const item of counts) {
    if (!rows.has(item.feature_id)) {
      rows.set(item.feature_id, {
        featureId: item.feature_id, label: item.label,
        counts: Object.fromEntries(columns.map(column => [column.key, 0])), total: 0,
      });
    }
    const row = rows.get(item.feature_id)!;
    const key = keys.get(item.category);
    if (key) row.counts[key] += item.count;
    row.total += item.count;
  }
  return { columns, rows: [...rows.values()] };
};
