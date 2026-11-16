import type { PoolClient } from 'pg';
import { AnalysisError, AnalysisInputError } from '../analysis/errors';
import type { AnalysisSpec } from '../analysis/protocol';
import { sha256, type MoranParameters } from './pythonWorker';
import type { Operator, PythonSnapshot } from './types';

export interface MoranSpec extends AnalysisSpec, MoranParameters {
  schemaVersion: 1;
  kind: 'spatial_autocorrelation';
  operatorVersion: 2;
  target: { fileId: string; valueField: string };
}

const invalid = (message: string) => new AnalysisInputError(message, 'INVALID_SPEC');
const readObject = (value: unknown, fields: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw invalid('空间自相关参数包含无效或未知字段');
  }
  return value as Record<string, unknown>;
};
const stringField = (value: unknown, message: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid(message);
  return value;
};
const integerField = (value: unknown, fallback: number, max: number, message: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalid(message);
  return value;
};

export const parseMoranSpec = (input: unknown): MoranSpec => {
  const raw = readObject(input, ['schemaVersion', 'kind', 'operatorVersion', 'target', 'contiguity', 'permutations', 'seed']);
  if (raw.schemaVersion !== 1 || raw.kind !== 'spatial_autocorrelation' || raw.operatorVersion !== 2) {
    throw invalid('不支持的空间自相关协议或算子版本');
  }
  const target = readObject(raw.target, ['fileId', 'valueField']);
  const contiguity = raw.contiguity === undefined ? 'queen' : raw.contiguity;
  if (contiguity !== 'queen' && contiguity !== 'rook') throw invalid('邻接规则必须为 queen 或 rook');
  return {
    schemaVersion: 1, kind: 'spatial_autocorrelation', operatorVersion: 2,
    target: {
      fileId: stringField(target.fileId, '请选择有效的面图层', 50),
      valueField: stringField(target.valueField, '请选择有效的数值字段', 255),
    },
    contiguity,
    permutations: integerField(raw.permutations, 199, 9999, '置换次数须为 0–9999 的整数'),
    seed: integerField(raw.seed, 42, 4294967295, '随机种子须为无符号 32 位整数'),
  };
};

const maxFeatures = 20000;
const maxSnapshotBytes = 64 * 1024 * 1024;
const crs = 'EPSG:4326';

async function capture(client: PoolClient, spec: MoranSpec): Promise<PythonSnapshot> {
  const { fileId, valueField } = spec.target;
  const { rows: [row] } = await client.query<{
    present: boolean; count: number; valid: boolean; field_present: boolean; payload: Buffer;
  }>(`
    WITH features AS (
      SELECT id, geom, properties FROM spatial_features WHERE file_id=$1 ORDER BY id LIMIT $3
    )
    SELECT EXISTS(SELECT 1 FROM file_nodes WHERE id=$1 AND type='file') AS present,
      count(*)::int AS count,
      bool_and(geom IS NOT NULL AND ST_SRID(geom)=4326 AND ST_NDims(geom)=2 AND NOT ST_IsEmpty(geom)
        AND GeometryType(geom) IN ('POLYGON','MULTIPOLYGON') AND ST_IsValid(geom)) AS valid,
      bool_or(properties ? $2) AS field_present,
      convert_to(jsonb_build_object('crs',$4::text,'valueColumn',$2::text,'features',jsonb_agg(jsonb_build_object(
        'id',id::text,'wkb',encode(ST_AsBinary(geom,'NDR'),'hex'),'value',properties -> $2
      ) ORDER BY id))::text,'UTF8') AS payload
    FROM features
`, [fileId, valueField, maxFeatures + 1, crs]);
  if (!row.present) throw new AnalysisInputError('面图层不存在', 'DATASET_NOT_FOUND');
  if (row.count < 3 || row.count > maxFeatures) throw invalid('面图层须包含 3–20000 个要素');
  if (!row.valid) throw new AnalysisInputError('面图层须由有效的 EPSG:4326 二维面组成', 'INVALID_GEOMETRY');
  if (!row.field_present) throw new AnalysisInputError('目标图层中不存在所选字段', 'UNKNOWN_FIELD');
  if (row.payload.length > maxSnapshotBytes) throw invalid('输入快照超过 64 MiB');
  const digest = sha256(row.payload);
  return { payload: row.payload, digest, versions: { target: { fileId, count: row.count, fingerprint: digest } } };
}

interface MoranLocal {
  id: string; i: number; expected_i: number; z: number; lag_z: number;
  neighbor_count: number; p: number | null; quadrant: 'HH' | 'HL' | 'LH' | 'LL' | null;
}

interface MoranResult {
  value_column: string; crs: string; contiguity: string; permutations: number; seed: number;
  global_i: number; global_expected_i: number; global_p: number | null;
  s0: number; excluded_value_ids: string[]; local: MoranLocal[];
}

const probability = (value: unknown) => value === null || (typeof value === 'number' && value > 0 && value <= 1);
const failure = () => new AnalysisError(500, 'EXECUTION_FAILED', 'Python Worker 的结果与输入快照或参数不一致');
function checkResult(output: unknown, spec: MoranSpec, payload: Buffer): MoranResult {
  const result = output as MoranResult;
  if (!result || result.value_column !== spec.target.valueField || result.crs !== crs
    || result.contiguity !== spec.contiguity || result.seed !== spec.seed || result.permutations !== spec.permutations
    || !Number.isFinite(result.global_i) || !Number.isFinite(result.global_expected_i)
    || !probability(result.global_p) || (result.global_p === null) !== (spec.permutations === 0)
    || !Array.isArray(result.excluded_value_ids) || !Array.isArray(result.local) || result.local.length < 3) throw failure();

  const { features } = JSON.parse(payload.toString('utf8')) as { features: { id: string }[] };
  const ids = new Set(features.map(feature => feature.id));
  for (const id of result.excluded_value_ids) {
    if (!ids.delete(id)) throw failure();
  }
  let connected = 0;
  for (const row of result.local) {
    if (!row || !ids.delete(row.id) || ![row.i, row.expected_i, row.z, row.lag_z].every(Number.isFinite)
      || !Number.isInteger(row.neighbor_count) || row.neighbor_count < 0 || row.neighbor_count >= result.local.length
      || !probability(row.p) || (row.p === null) !== (row.neighbor_count === 0 || spec.permutations === 0)
      || ![null, 'HH', 'HL', 'LH', 'LL'].includes(row.quadrant)
      || (row.neighbor_count === 0 && (row.i !== 0 || row.expected_i !== 0 || row.lag_z !== 0 || row.quadrant !== null))) {
      throw failure();
    }
    connected += Number(row.neighbor_count > 0);
  }
  if (ids.size || connected === 0 || result.s0 !== connected) throw failure();
  return result;
}

export const moranLisa: Operator = {
  descriptor: {
    id: 'spatial_autocorrelation', version: 2, name: 'Moran/LISA 空间自相关',
    executor: 'python', inputs: { target: { geometryTypes: ['ST_Polygon', 'ST_MultiPolygon'] } },
    parameterSchema: '#/$defs/MoranLisaSpec', output: { format: 'moran_lisa', schemaVersion: 1 },
  },
  prepare(input) {
    const spec = parseMoranSpec(input);
    return {
      spec,
      executor: 'python',
      capture: client => capture(client, spec),
      async execute(worker, execution) {
        const { result: output, algorithmVersion, dependencyLockDigest } = await worker.moran(execution, spec);
        const result = checkResult(output, spec, execution.payload);
        return {
          columns: [
            { key: 'localI', label: '局部 Moran’s I' }, { key: 'expectedI', label: '局部 I 的条件期望' },
            { key: 'z', label: '标准化值' }, { key: 'lagZ', label: '空间滞后' },
            { key: 'neighborCount', label: '邻居数' }, { key: 'pValue', label: '局部置换 p 值' },
            { key: 'quadrant', label: '象限' },
          ],
          totalRows: result.local.length,
          summary: {
            algorithmVersion, dependencyLockDigest, executionId: execution.id, inputDigest: execution.digest,
            globalI: result.global_i, expectedI: result.global_expected_i, pValue: result.global_p,
            s0: result.s0, excludedValueIds: result.excluded_value_ids.map(Number),
            crs, valueField: spec.target.valueField,
            contiguity: spec.contiguity, permutations: spec.permutations, seed: spec.seed,
          },
          async writeRows(client, id) {
            const written = await client.query(`
              INSERT INTO geocsv_analysis_moran_rows(artifact_id,feature_id,local_i,expected_i,z,lag_z,neighbor_count,p_value,quadrant,geom)
              SELECT $1,r.id::int,r.i,r.expected_i,r.z,r.lag_z,r.neighbor_count,r.p,r.quadrant,
                ST_GeomFromWKB(decode(f.wkb,'hex'),4326)
              FROM jsonb_to_recordset($2::jsonb) AS r(id text,i float8,expected_i float8,z float8,lag_z float8,neighbor_count int,p float8,quadrant text)
              JOIN jsonb_to_recordset($3::jsonb -> 'features') AS f(id text,wkb text) USING(id)
            `, [
              id, JSON.stringify(result.local), execution.payload.toString('utf8'),
            ]);
            if (written.rowCount !== result.local.length) throw failure();
          },
        };
      },
    };
  },
};
