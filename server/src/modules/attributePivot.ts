import type { Pool, PoolClient } from 'pg';
import { AnalysisInputError } from './spatialPivot/plan';

const field = (value: unknown, required: boolean): string | null => {
  if (!required && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || value.includes('\0')) {
    throw new AnalysisInputError('缺少有效的透视字段');
  }
  return value.replace(/^properties\./, '');
};

export const queryAttributePivot = async (db: Pick<Pool | PoolClient, 'query'>, input: Record<string, unknown>) => {
  if (typeof input.fileId !== 'string' || !input.fileId) throw new AnalysisInputError('缺少文件 ID');
  const rowField = field(input.groupByRow, true)!;
  const columnField = field(input.groupByCol, false);
  const functions: Record<string, string> = { count: 'COUNT', sum: 'SUM', avg: 'AVG', max: 'MAX', min: 'MIN', boxplot: 'jsonb_agg', ridgeline: 'jsonb_agg' };
  const method = typeof input.method === 'string' ? input.method : '';
  if (!Object.prototype.hasOwnProperty.call(functions, method)) throw new AnalysisInputError('不支持的聚合方法');
  const raw = method === 'boxplot' || method === 'ridgeline';
  if (raw && columnField) throw new AnalysisInputError('二维模式不支持原始分布聚合');
  const valueField = field(input.valueField, method !== 'count');
  const numericValue = `NULLIF(BTRIM(properties ->> $4::text), '')::numeric`;
  const aggregation = method === 'count' ? 'COUNT(*)' : `${functions[method]}(${numericValue})`;
  const result = await db.query(`
    SELECT NULLIF(properties ->> $2::text, '') AS row_key,
           NULLIF(properties ->> $3::text, '') AS col_key, ${aggregation} AS value
    FROM spatial_features WHERE file_id = $1
    GROUP BY row_key, col_key ORDER BY row_key NULLS FIRST, col_key NULLS FIRST`,
    method === 'count' ? [input.fileId, rowField, columnField] : [input.fileId, rowField, columnField, valueField]);
  // Keep the legacy flat response while giving missing groups a non-colliding label.
  const labels = new Set(result.rows.flatMap(row => [row.row_key, row.col_key]).filter(value => value !== null && value !== '').map(String));
  let missingLabel = '未分类';
  let suffix = 0;
  while (labels.has(missingLabel)) missingLabel = `未分类（空值${suffix++ || ''}）`;
  const label = (value: unknown) => value === null || value === undefined || value === '' ? missingLabel : String(value);
  if (!columnField) return {
    success: true,
    data: result.rows.map((row, index) => ({
      key: index, rowKey: label(row.row_key),
      value: raw ? (row.value || []).filter((value: unknown) => value !== null) : row.value === null ? null : Number(row.value),
    })),
    columns: [method === 'boxplot' ? 'boxplot_raw' : method === 'ridgeline' ? 'ridgeline_raw' : 'value'],
    meta: { groupByRow: input.groupByRow, groupByCol: input.groupByCol, valueField: input.valueField, method },
  };
  const columns = [...new Set(result.rows.map(row => label(row.col_key)))].sort();
  // Old clients reserve these properties for their row identity.
  if (columns.some(key => ['key', 'rowKey', '__proto__', 'constructor', 'prototype'].includes(key))) {
    throw new AnalysisInputError('分类值与旧透视表保留列冲突，请重命名分类值或使用空间透视结果');
  }
  const rows = new Map<string, Record<string, unknown>>();
  for (const item of result.rows) {
    const rowKey = label(item.row_key);
    if (!rows.has(rowKey)) rows.set(rowKey, { key: rowKey, rowKey });
    rows.get(rowKey)![label(item.col_key)] = item.value === null ? null : Number(item.value);
  }
  return { success: true, data: [...rows.values()], columns,
    meta: { groupByRow: input.groupByRow, groupByCol: input.groupByCol, valueField: input.valueField, method } };
};
