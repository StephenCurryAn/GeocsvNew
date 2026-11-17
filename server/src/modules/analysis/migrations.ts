import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './database';
import { LEGACY_ANALYSIS_SCHEMA } from './legacySchema';

const legacyTables = [
  'geocsv_analysis_artifact_rows', 'geocsv_analysis_artifacts', 'geocsv_analysis_runs', 'geocsv_analysis_definitions',
];
const requestColumns = ['request_actor', 'request_scope', 'request_key', 'request_hash'];

const columns = async (client: PoolClient, schemaOid: number, tables: string[]) => (await client.query(`
  SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
         pg_get_expr(d.adbin, d.adrelid) AS default_value
  FROM pg_class c
  JOIN pg_attribute a ON c.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE c.relnamespace=$1 AND c.relname=ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY c.relname, a.attname`, [schemaOid, tables])).rows;

const constraints = async (client: PoolClient, schemaOid: number) => (await client.query(`
  SELECT c.relname, k.contype, k.conkey, pg_get_expr(k.conbin, k.conrelid) AS check_expression,
         k.convalidated, k.condeferrable, k.condeferred,
         f.relname AS foreign_table, (f.relnamespace=c.relnamespace) AS local_fk, k.confkey,
         k.confupdtype, k.confdeltype, k.confmatchtype
  FROM pg_class c JOIN pg_constraint k ON c.oid=k.conrelid
  LEFT JOIN pg_class f ON f.oid=k.confrelid
  WHERE c.relnamespace=$1 AND c.relname=ANY($2::text[])
  ORDER BY c.relname, k.contype, k.conkey`, [schemaOid, legacyTables])).rows;

const baseline = async (client: PoolClient, schemaOid: number) => {
  const tables = (await client.query(`
    SELECT relkind, relpersistence FROM pg_class WHERE relnamespace=$1 AND relname=ANY($2::text[])`,
    [schemaOid, legacyTables])).rows;
  if (!tables.length) {
    await client.query(LEGACY_ANALYSIS_SCHEMA);
    return;
  }
  const mismatch = () => new Error('现有分析表结构与版本 1 基线不符，迁移已回滚');
  if (tables.length !== legacyTables.length || tables.some(row => row.relkind !== 'r' || row.relpersistence !== 'p')) {
    throw mismatch();
  }

  // Compare to reference tables created from the same DDL that bootstraps new databases.
  await client.query(LEGACY_ANALYSIS_SCHEMA.replace(/CREATE TABLE/g, 'CREATE TEMP TABLE'));
  const referenceOid: number = (await client.query('SELECT pg_my_temp_schema() AS oid')).rows[0].oid;
  const legacyColumns = (await columns(client, schemaOid, legacyTables)).filter(
    row => row.relname !== 'geocsv_analysis_runs' || !requestColumns.includes(row.attname),
  );
  if (!isDeepStrictEqual(legacyColumns, await columns(client, referenceOid, legacyTables))
    || !isDeepStrictEqual(await constraints(client, schemaOid), await constraints(client, referenceOid))) {
    throw mismatch();
  }
  await client.query(`DROP TABLE ${legacyTables.map(table => `pg_temp.${table}`).join(', ')}`);
  await client.query('CREATE INDEX IF NOT EXISTS geocsv_runs_queue ON geocsv_analysis_runs(status, created_at)');
};

const submissionKeys = async (client: PoolClient, schemaOid: number) => {
  // IF NOT EXISTS also accepts the transitional DDL from the idempotency batch.
  await client.query(`
    ALTER TABLE geocsv_analysis_runs
      ADD COLUMN IF NOT EXISTS request_actor TEXT,
      ADD COLUMN IF NOT EXISTS request_scope TEXT,
      ADD COLUMN IF NOT EXISTS request_key TEXT,
      ADD COLUMN IF NOT EXISTS request_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS geocsv_runs_request_key
      ON geocsv_analysis_runs(request_actor, request_scope, request_key);
  `);
  const fields = (await columns(client, schemaOid, ['geocsv_analysis_runs']))
    .filter(row => requestColumns.includes(row.attname));
  const index = (await client.query(`
    SELECT i.indisunique AND i.indisvalid AND i.indimmediate AND i.indpred IS NULL
      AND i.indnatts=3 AND pg_get_indexdef(i.indexrelid,1,false)='request_actor'
      AND pg_get_indexdef(i.indexrelid,2,false)='request_scope'
      AND pg_get_indexdef(i.indexrelid,3,false)='request_key' AS valid
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid
    WHERE c.relname='geocsv_runs_request_key' AND t.relname='geocsv_analysis_runs' AND t.relnamespace=$1`, [schemaOid])).rows[0];
  if (fields.some(row => row.type !== 'text' || row.attnotnull || row.default_value !== null) || !index?.valid) {
    throw new Error('现有请求键字段或唯一索引与版本 2 不符，迁移已回滚');
  }
  await client.query(`ALTER TABLE geocsv_analysis_runs ADD CONSTRAINT geocsv_analysis_request_complete
    CHECK (num_nonnulls(request_actor, request_scope, request_key, request_hash) IN (0,4))`);
};

const plansAndArtifactFormats = async (client: PoolClient) => {
  await client.query(`
    CREATE TABLE geocsv_analysis_plans (
      id UUID PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      spec JSONB NOT NULL,
      spec_hash TEXT NOT NULL,
      input_versions JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at TIMESTAMPTZ
    );
    ALTER TABLE geocsv_analysis_runs
      ADD COLUMN plan_id UUID REFERENCES geocsv_analysis_plans(id),
      ADD COLUMN error_code TEXT;
    ALTER TABLE geocsv_analysis_artifacts
      ADD COLUMN format TEXT NOT NULL DEFAULT 'spatial_counts',
      ADD COLUMN schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version > 0);
  `);
};

const pythonSnapshotsAndResults = async (client: PoolClient) => {
  await client.query(`
    CREATE TABLE geocsv_analysis_snapshots (
      id UUID PRIMARY KEY,
      digest TEXT NOT NULL,
      payload BYTEA,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
    );
    CREATE INDEX geocsv_snapshots_expiry ON geocsv_analysis_snapshots(expires_at) WHERE payload IS NOT NULL;
    ALTER TABLE geocsv_analysis_runs ADD COLUMN snapshot_id UUID REFERENCES geocsv_analysis_snapshots(id);
    CREATE INDEX geocsv_runs_snapshot ON geocsv_analysis_runs(snapshot_id) WHERE snapshot_id IS NOT NULL;
    CREATE TABLE geocsv_analysis_moran_rows (
      artifact_id UUID NOT NULL REFERENCES geocsv_analysis_artifacts(id) ON DELETE CASCADE,
      feature_id INTEGER NOT NULL,
      local_i DOUBLE PRECISION NOT NULL,
      expected_i DOUBLE PRECISION NOT NULL,
      z DOUBLE PRECISION NOT NULL,
      lag_z DOUBLE PRECISION NOT NULL,
      neighbor_count INTEGER NOT NULL CHECK (neighbor_count >= 0),
      p_value DOUBLE PRECISION CHECK (p_value > 0 AND p_value <= 1),
      quadrant TEXT CHECK (quadrant IN ('HH','HL','LH','LL')),
      geom GEOMETRY(Geometry,4326) NOT NULL,
      PRIMARY KEY (artifact_id, feature_id)
    );
  `);
};

const sceneAnalysisMetadata = async (client: PoolClient) => {
  await client.query(`
    CREATE TABLE geocsv_analysis_dataset_periods (
      file_id TEXT PRIMARY KEY REFERENCES file_nodes(id) ON DELETE CASCADE,
      month TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
    );
    ALTER TABLE geocsv_analysis_moran_rows ADD COLUMN label TEXT;
  `);
};

const professionalModels = async (client: PoolClient) => {
  await client.query(`
    CREATE TABLE geocsv_professional_models (
      id UUID NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      revision UUID NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      operator_version INTEGER NOT NULL,
      parameters JSONB NOT NULL,
      published_at TIMESTAMPTZ,
      trial_run_id UUID REFERENCES geocsv_analysis_runs(id),
      PRIMARY KEY (id, version),
      CHECK ((published_at IS NULL) = (trial_run_id IS NULL))
    );
    CREATE UNIQUE INDEX geocsv_professional_model_draft ON geocsv_professional_models(id) WHERE published_at IS NULL;
    ALTER TABLE geocsv_analysis_runs ADD COLUMN professional_model JSONB;
    CREATE INDEX geocsv_professional_model_trial ON geocsv_analysis_runs((professional_model->>'revision'))
      WHERE professional_model->>'purpose' = 'trial' AND status = 'succeeded';
    CREATE INDEX geocsv_professional_model_history ON geocsv_analysis_runs((professional_model->>'sceneId'), created_at DESC)
      WHERE professional_model IS NOT NULL;
  `);
};

const migrations = [baseline, submissionKeys, plansAndArtifactFormats, pythonSnapshotsAndResults, sceneAnalysisMetadata, professionalModels];

export const migrateAnalysis = async (db: Pool): Promise<void> => {
  await transaction(db, 'BEGIN', async client => {
    await client.query('SELECT pg_advisory_xact_lock(193607242)');
    const schemaOid: number = (await client.query(`
      SELECT oid FROM pg_namespace WHERE nspname=current_schema()`)).rows[0].oid;
    await client.query(`
      CREATE TABLE IF NOT EXISTS geocsv_analysis_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM geocsv_analysis_migrations ORDER BY version',
    );
    if (rows.length > migrations.length || rows.some((row, index) => row.version !== index + 1)) {
      throw new Error('分析迁移版本记录与当前服务不兼容');
    }
    for (let index = rows.length; index < migrations.length; index++) {
      await migrations[index](client, schemaOid);
      await client.query('INSERT INTO geocsv_analysis_migrations(version) VALUES($1)', [index + 1]);
    }
  });
};
