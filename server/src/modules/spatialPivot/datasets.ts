import type { Pool, PoolClient } from 'pg';
import { AnalysisInputError, SPATIAL_PIVOT_OPERATOR, type SpatialPivotSpec } from './plan';

type Database = Pick<Pool | PoolClient, 'query'>;

export interface DatasetSummary {
  fileId: string; name: string; featureCount: number; geometryTypes: string[]; fields: string[];
}

export const readDataset = async (db: Database, fileId: string): Promise<DatasetSummary> => {
  const file = await db.query('SELECT id, name FROM file_nodes WHERE id = $1 AND type = $2', [fileId, 'file']);
  if (!file.rowCount) throw new AnalysisInputError('数据集不存在', 'DATASET_NOT_FOUND');
  const metadata = await db.query(`
    SELECT COUNT(*)::integer AS count,
           COALESCE(array_agg(DISTINCT ST_GeometryType(geom)) FILTER (WHERE geom IS NOT NULL), '{}') AS types
    FROM spatial_features WHERE file_id = $1`, [fileId]);
  const fields = await db.query(`
    SELECT DISTINCT key FROM spatial_features,
      LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(properties) = 'object' THEN properties ELSE '{}'::jsonb END) AS key
    WHERE file_id = $1 ORDER BY key`, [fileId]);
  return {
    fileId, name: file.rows[0].name, featureCount: metadata.rows[0].count,
    geometryTypes: metadata.rows[0].types, fields: fields.rows.map(row => row.key),
  };
};

export const validateDatasets = async (db: Database, spec: SpatialPivotSpec) => {
  const target = await readDataset(db, spec.target.fileId);
  const join = await readDataset(db, spec.join.fileId);
  for (const [dataset, allowed] of [
    [target, SPATIAL_PIVOT_OPERATOR.targetGeometry], [join, SPATIAL_PIVOT_OPERATOR.joinGeometry],
  ] as const) {
    if (dataset.geometryTypes.some(type => !(allowed as readonly string[]).includes(type))) {
      throw new AnalysisInputError(`${dataset.name} 的几何类型不符合算子要求（行政区面、POI 点）`, 'INVALID_GEOMETRY');
    }
  }
  for (const [dataset, field] of [[target, spec.target.labelField], [join, spec.join.categoryField]] as const) {
    if (field !== null && !dataset.fields.includes(field)) throw new AnalysisInputError(`${dataset.name} 不存在字段 ${field}`, 'UNKNOWN_FIELD');
  }
  const quality = await db.query(`
    SELECT COUNT(*)::integer AS invalid FROM spatial_features
    WHERE file_id = ANY($1::text[])
      AND (geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom) OR ST_SRID(geom) <> 4326)`,
    [[spec.target.fileId, spec.join.fileId]]);
  if (quality.rows[0].invalid > 0) throw new AnalysisInputError('图层包含空几何、无效几何或不支持的坐标系，请先修复数据', 'INVALID_GEOMETRY');
  return { target, join };
};

export const fingerprintDataset = async (db: Database, fileId: string) => {
  const result = await db.query(`
    SELECT COUNT(*)::integer AS count,
      md5(COALESCE(string_agg(md5(id::text || ':' || COALESCE(ST_AsEWKB(geom)::text, '') || ':' ||
        COALESCE(properties::text, 'null')), ',' ORDER BY id), '')) AS fingerprint
    FROM spatial_features WHERE file_id = $1`, [fileId]);
  return { fileId, count: result.rows[0].count as number, fingerprint: result.rows[0].fingerprint as string };
};
