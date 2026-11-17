import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AnalysisError, AnalysisInputError } from '../analysis/errors';
import type { OperatorRef } from '../analysis/protocol';
import { hasKey, readOperatorParameters } from '../operators/parameters';
import { record } from '../operators/planning';
import { listRegisteredOperators, requireOperator } from '../operators/registry';
import type { Operator } from '../operators/types';

type Parameters = Record<string, string | number>;
interface ModelRow {
  id: string;
  version: number;
  revision: string;
  name: string;
  description: string;
  operator_id: string;
  operator_version: number;
  parameters: Parameters;
  published_at: Date | null;
  trial_run_id: string | null;
}

const rows = 'geocsv_professional_models';
const revisionConflict = () => new AnalysisError(409, 'MODEL_REVISION_CONFLICT', '模型配置已变化，请刷新后重试');
export const modelNotFound = () => new AnalysisError(404, 'MODEL_NOT_FOUND', '找不到此模型版本');

export const professionalOperator = (ref: OperatorRef) => {
  const operator = requireOperator({ kind: ref.id, operatorVersion: ref.version });
  if (!operator.professionalInputs) {
    throw new AnalysisInputError('此算子尚未登记为专业模型执行入口', 'UNSUPPORTED_OPERATOR');
  }
  return { ...operator, professionalInputs: operator.professionalInputs };
};

const describe = ({ descriptor, professionalInputs }: Operator) => ({
  id: descriptor.id, version: descriptor.version, name: descriptor.name, description: descriptor.description,
  inputs: professionalInputs, parameters: descriptor.planningParameters.properties, output: descriptor.output,
});

export const professionalOperators = () => listRegisteredOperators()
  .filter(operator => operator.professionalInputs).map(describe);

const operatorRef = (row: ModelRow) => ({ id: row.operator_id, version: row.operator_version });
const modelData = (row: ModelRow) => ({
  id: row.id, version: row.version, revision: row.revision, name: row.name, description: row.description,
  operator: describe(professionalOperator(operatorRef(row))), parameters: row.parameters,
  publishedAt: row.published_at?.toISOString() ?? null, trialRunId: row.trial_run_id,
});

const readConfig = (value: unknown) => {
  if (!record(value) || Object.keys(value).some(key => !['name', 'description', 'operator', 'parameters', 'revision'].includes(key))
    || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80
    || typeof value.description !== 'string' || !value.description.trim() || value.description.trim().length > 500
    || !record(value.operator) || Object.keys(value.operator).some(key => key !== 'id' && key !== 'version')
    || typeof value.operator.id !== 'string' || typeof value.operator.version !== 'number' || !record(value.parameters)) {
    throw new AnalysisInputError('请填写模型名称（1–80 字）、说明（1–500 字）、算子及参数');
  }
  const operator = professionalOperator({ id: value.operator.id, version: value.operator.version });
  const parameters = readOperatorParameters(operator.descriptor.planningParameters, value.parameters);
  return [value.name.trim(), value.description.trim(), operator.descriptor.id, operator.descriptor.version, parameters] as const;
};

const successfulTrial = `SELECT r.id FROM geocsv_analysis_runs r
  WHERE r.professional_model->>'revision'=m.revision::text AND r.professional_model->>'purpose'='trial'
    AND r.status='succeeded' AND r.artifact_id IS NOT NULL
  ORDER BY r.completed_at DESC, r.id LIMIT 1`;

export const listModels = async (db: Pool, manage: boolean) => {
  const { rows: models } = await db.query<ModelRow>(`
    SELECT DISTINCT ON (m.id) m.id,m.version,m.revision,m.name,m.description,m.operator_id,m.operator_version,
      m.parameters,m.published_at,
      ${manage ? `COALESCE(m.trial_run_id, (${successfulTrial}))` : 'm.trial_run_id'} AS trial_run_id
    FROM ${rows} m ${manage ? '' : 'WHERE m.published_at IS NOT NULL'} ORDER BY m.id,m.version DESC`);
  return models.map(modelData).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
};

export const getModel = async (db: Pool, id: string, version: number) => {
  const { rows: [model] } = await db.query<ModelRow>(`SELECT * FROM ${rows} WHERE id=$1 AND version=$2`, [id, version]);
  if (!model) throw modelNotFound();
  return model;
};

export const createModel = async (db: Pool, input: unknown) => {
  const { rows: [model] } = await db.query<ModelRow>(`
    INSERT INTO ${rows}(id,version,revision,name,description,operator_id,operator_version,parameters)
    VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), randomUUID(), ...readConfig(input)]);
  return modelData(model);
};

export const updateDraft = async (db: Pool, id: string, version: number, revision: string, input: unknown) => {
  const { rows: [model] } = await db.query<ModelRow>(`
    UPDATE ${rows} SET revision=$4,name=$5,description=$6,operator_id=$7,operator_version=$8,parameters=$9
    WHERE id=$1 AND version=$2 AND revision=$3 AND published_at IS NULL RETURNING *`,
  [id, version, revision, randomUUID(), ...readConfig(input)]);
  if (!model) throw revisionConflict();
  return modelData(model);
};

export const createNextDraft = async (db: Pool, id: string, version: number) => {
  const { rows: [model] } = await db.query<ModelRow>(`
    INSERT INTO ${rows}(id,version,revision,name,description,operator_id,operator_version,parameters)
    SELECT id,version+1,$3,name,description,operator_id,operator_version,parameters FROM ${rows} m
    WHERE id=$1 AND version=$2 AND published_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ${rows} newer WHERE newer.id=m.id AND newer.version>m.version)
    ON CONFLICT DO NOTHING RETURNING *`, [id, version, randomUUID()]);
  if (!model) throw revisionConflict();
  return modelData(model);
};

export const publishModel = async (db: Pool, id: string, version: number, revision: string) => {
  const { rows: [model] } = await db.query<ModelRow>(`
    UPDATE ${rows} m SET published_at=now(),trial_run_id=trial.id
    FROM (SELECT m.revision,(${successfulTrial}) AS id FROM ${rows} m WHERE m.revision=$3) trial
    WHERE m.id=$1 AND m.version=$2 AND m.revision=trial.revision AND m.published_at IS NULL
      AND trial.id IS NOT NULL RETURNING m.*`, [id, version, revision]);
  if (model) return modelData(model);
  const current = await getModel(db, id, version);
  if (current.revision !== revision) throw revisionConflict();
  if (current.published_at) return modelData(current);
  throw new AnalysisError(409, 'MODEL_TRIAL_REQUIRED', '此草稿需试跑成功后才能发布');
};

export const modelSpec = (model: ModelRow, input: unknown) => {
  const operator = professionalOperator(operatorRef(model));
  if (!record(input) || Object.keys(input).some(role => !hasKey(operator.professionalInputs, role))) {
    throw new AnalysisInputError('图层输入不符合算子要求');
  }
  for (const [role, definition] of Object.entries(operator.professionalInputs)) {
    const binding = input[role];
    if (!record(binding) || typeof binding.fileId !== 'string'
      || Object.keys(binding).some(key => key !== 'fileId' && !hasKey(definition.fields ?? {}, key))) {
      throw new AnalysisInputError('请选择图层及算子要求的字段');
    }
  }
  return { ...model.parameters, ...input, schemaVersion: 1, kind: model.operator_id, operatorVersion: model.operator_version };
};
