import type { PoolClient } from 'pg';
import { AnalysisError, AnalysisInputError } from '../analysis/errors';
import type { AnalysisSpec, OperatorParameterSchema } from '../analysis/protocol';
import { fieldLabel, requestedFieldMeaning, requestedMonth } from '../analysisPlanner/sceneDataMeaning';
import { clarification } from '../analysisPlanner/types';
import { readDataset } from '../spatialPivot/datasets';
import { readOperatorParameters } from './parameters';
import { fitsInput, mentions, namedDatasets, sameOperator, type OperatorDraftContext } from './planning';
import { sha256, type MoranParameters } from './pythonWorker';
import type { Operator, PythonSnapshot } from './types';

export interface MoranSpec extends AnalysisSpec, MoranParameters {
  schemaVersion: 1;
  kind: 'spatial_autocorrelation';
  operatorVersion: 2;
  target: { fileId: string; valueField: string; labelField?: string };
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
const parameters = {
  type: 'object', additionalProperties: false,
  properties: {
    contiguity: { type: 'string', enum: ['queen', 'rook'], default: 'queen',
      description: '邻接规则。queen 表示共点或共边，rook 表示仅共边' },
    permutations: { type: 'integer', minimum: 0, maximum: 9999, default: 199, description: '置换次数，0 表示不进行置换检验' },
    seed: { type: 'integer', minimum: 0, maximum: 4294967295, default: 42, description: '随机种子' },
  },
} as const satisfies OperatorParameterSchema;

export const parseMoranSpec = (input: unknown): MoranSpec => {
  const raw = readObject(input, ['schemaVersion', 'kind', 'operatorVersion', 'target', 'contiguity', 'permutations', 'seed']);
  if (raw.schemaVersion !== 1 || raw.kind !== 'spatial_autocorrelation' || raw.operatorVersion !== 2) {
    throw invalid('不支持的空间自相关协议或算子版本');
  }
  const target = readObject(raw.target, ['fileId', 'valueField', 'labelField']);
  const effective = readOperatorParameters(parameters, {
    contiguity: raw.contiguity, permutations: raw.permutations, seed: raw.seed,
  });
  return {
    schemaVersion: 1, kind: 'spatial_autocorrelation', operatorVersion: 2,
    target: {
      fileId: stringField(target.fileId, '请选择有效的面图层', 50),
      valueField: stringField(target.valueField, '请选择有效的数值字段', 255),
      ...(target.labelField === undefined ? {} : { labelField: stringField(target.labelField, '无效的区域名称字段', 255) }),
    },
    ...effective,
  };
};

const numberPattern = '([+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:e[+-]?\\d+)?)';
const permutationsPattern = new RegExp(numberPattern + '\\s*次\\s*置换|置换(?:次数)?\\s*(?:为|是|[:=])?\\s*' + numberPattern
  + '|' + numberPattern + '\\s+permutations\\b|\\bpermutations\\s*(?:[:=]\\s*)?' + numberPattern, 'gi');
const seedPattern = new RegExp('(?:随机种子|种子|\\bseed)\\s*(?:为|是|[:=])?\\s*' + numberPattern, 'gi');
// undefined means the user left the parameter at its default; null means it needs clarification.
const requestedNumber = (prompt: string, pattern: RegExp, parameter: RegExp): number | null | undefined => {
  const values = [...prompt.matchAll(pattern)]
    .map(match => Number(match.slice(1).find(value => value !== undefined)?.replace(/,/g, '')));
  if (values.length) return values.every(value => value === values[0]) ? values[0] : null;
  return parameter.test(prompt) ? null : undefined;
};

const planDraft = (context: OperatorDraftContext) => {
  const proposed = context.inputs.target;
  const effective = readOperatorParameters(parameters, context.parameters);
  const prompt = context.userPrompt.normalize('NFKC');
  const explicitLayers = namedDatasets(prompt, context.datasets);
  const previous = context.history && sameOperator(context.history.operator, moranLisa.descriptor)
    ? context.history.fileIds.target : undefined;
  const eligible = context.datasets.filter(item => fitsInput(item, moranLisa.descriptor.inputs.target));
  const choices = explicitLayers.length ? eligible.filter(item => explicitLayers.includes(item))
    : previous ? eligible.filter(item => item.fileId === previous) : eligible;
  const month = requestedMonth(prompt);
  const inPeriod = month ? choices.filter(item => item.dataMonth === month) : choices;
  if (month && !inPeriod.length) {
    return clarification(`当前场景中没有已核实为 ${month} 的社区统计数据。你可以补充这段时间的数据，或告诉我改用哪个已有时段。`);
  }
  const fields = inPeriod.flatMap(dataset => (dataset.numericFields ?? []).map(valueField => ({ dataset, valueField })));
  const explicit = fields.filter(item => mentions(prompt, item.valueField));
  const meaning = requestedFieldMeaning(prompt);
  const inferred = meaning ? fields.filter(item => meaning.fields.test(item.valueField))
    : fields.filter(item => !/(?:^|_)(?:id|code|编号|编码)(?:$|_)/i.test(item.valueField));
  const bindings = explicit.length ? explicit : inferred;
  if (bindings.length !== 1) {
    if (!bindings.length && meaning) return clarification(`当前场景的可用面数据缺少「${meaning.label}」。你想补充这份统计数据，还是比较另一种指标？`);
    const options = [...new Set(bindings.map(item => fieldLabel(item.valueField)))].slice(0, 5);
    const layers = new Set(bindings.map(item => item.dataset.name));
    return clarification(layers.size > 1 && options.length === 1
      ? `当前场景有多份包含「${options[0]}」的数据。你想用哪份？候选为${[...layers].slice(0, 5).join('、')}。`
      : `你想比较哪种指标？${options.length ? '可用指标有' + options.join('、') + '。' : ''}`);
  }
  const { dataset, valueField } = bindings[0];
  if (dataset.fileId !== proposed.dataset.fileId || valueField !== proposed.fields.valueField) {
    return clarification(`当前需求对应「${fieldLabel(valueField)}」。请确认是否按「${dataset.name}」里的这一指标分析。`);
  }
  const labelField = ['community', 'community_name', 'name', 'NAME', '名称', '社区'].find(field => dataset.fields.includes(field));
  const target = { fileId: dataset.fileId, valueField, ...(labelField ? { labelField } : {}) };
  if (/\bknn\b|最近邻|距离权重|自定义权重/i.test(prompt)) {
    return { status: 'unsupported' as const, message: 'Moran/LISA 当前提供 Queen 和 Rook 邻接。' };
  }
  const queen = /\bqueen\b|共点/i.test(prompt);
  const rook = /\brook\b|仅共边|只共边/i.test(prompt);
  const contiguity = queen ? 'queen' : rook || /共边/.test(prompt) ? 'rook' : undefined;
  const permutations = requestedNumber(prompt, permutationsPattern, /置换|\bpermutations?\b/i);
  const seed = requestedNumber(prompt, seedPattern, /随机种子|种子|\bseed\b/i);
  if ((queen && rook) || (contiguity && contiguity !== context.parameters.contiguity)
    || permutations === null || (permutations !== undefined && permutations !== context.parameters.permutations)
    || seed === null || (seed !== undefined && seed !== context.parameters.seed)) {
    return clarification('请确认唯一的 Queen 或 Rook 邻接规则、0–9999 次置换和有效的随机种子。');
  }
  const spec: MoranSpec = {
    schemaVersion: 1, kind: 'spatial_autocorrelation', operatorVersion: 2, target,
    contiguity: contiguity === undefined ? parameters.properties.contiguity.default : effective.contiguity,
    permutations: permutations === undefined ? parameters.properties.permutations.default : effective.permutations,
    seed: seed === undefined ? parameters.properties.seed.default : effective.seed,
  };
  return { status: 'ready' as const, source: 'llm' as const, message: 'Moran/LISA 空间自相关',
    spec, inputs: { targetName: dataset.name, metricLabel: fieldLabel(valueField),
      ...(dataset.dataMonth ? { dataMonth: dataset.dataMonth } : {}) } };
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
      ) || CASE WHEN $5::text IS NULL THEN '{}'::jsonb ELSE
        jsonb_build_object('label', LEFT(properties ->> $5::text, 160)) END ORDER BY id))::text,'UTF8') AS payload
    FROM features
`, [fileId, valueField, maxFeatures + 1, crs, spec.target.labelField ?? null]);
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

const targetInput = { geometryTypes: ['ST_Polygon', 'ST_MultiPolygon'],
  fields: { valueField: { type: 'numeric', required: true, description: '分析使用的数值字段' } },
} as const;

export const moranLisa: Operator = {
  descriptor: {
    id: 'spatial_autocorrelation', version: 2, name: 'Moran/LISA 空间自相关',
    aliases: ['Moran', 'LISA', '莫兰', '空间自相关', 'Queen', 'Rook'],
    description: '判断数值偏高或偏低的区域是否彼此相邻、哪里成片或和周围不同。使用面图层的数值指标计算 Moran’s I 与 LISA，适用 Queen 或 Rook 邻接。',
    executor: 'python',
    inputs: { target: targetInput },
    parameterSchema: '#/$defs/MoranLisaSpec', output: { format: 'moran_lisa', schemaVersion: 1 },
    planningParameters: parameters,
  },
  professionalInputs: { target: { ...targetInput, fields: {
    ...targetInput.fields,
    labelField: { type: 'any', required: false, description: '区域名称字段' },
  } } },
  planDraft,
  prepare(input) {
    const spec = parseMoranSpec(input);
    return {
      spec,
      executor: 'python',
      capture: client => capture(client, spec),
      async validatePlanningFields(client) {
        const data = await readDataset(client, spec.target.fileId, true);
        if (!data.numericFields?.includes(spec.target.valueField)) {
          throw invalid('所选字段须包含至少三个有效数值');
        }
        if (spec.target.labelField && !data.fields.includes(spec.target.labelField)) {
          throw new AnalysisInputError('所选区域名称字段不存在', 'UNKNOWN_FIELD');
        }
      },
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
              INSERT INTO geocsv_analysis_moran_rows(artifact_id,feature_id,local_i,expected_i,z,lag_z,neighbor_count,p_value,quadrant,geom,label)
              SELECT $1,r.id::int,r.i,r.expected_i,r.z,r.lag_z,r.neighbor_count,r.p,r.quadrant,
                ST_GeomFromWKB(decode(f.wkb,'hex'),4326), f.label
              FROM jsonb_to_recordset($2::jsonb) AS r(id text,i float8,expected_i float8,z float8,lag_z float8,neighbor_count int,p float8,quadrant text)
              JOIN jsonb_to_recordset($3::jsonb -> 'features') AS f(id text,wkb text,label text) USING(id)
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
