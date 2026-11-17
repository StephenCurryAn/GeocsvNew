const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const { LEGACY_ANALYSIS_SCHEMA } = require('../src/modules/analysis/legacySchema');
const { migrateAnalysis } = require('../src/modules/analysis/migrations');
const { AnalysisService } = require('../src/modules/analysis/service');
const { createSpatialPivotRouter } = require('../src/modules/spatialPivot/router');
const { SpatialPivotSpec: spec } = require('../../docs/contracts/analysis.examples.json');

const databaseUrl = process.env.TEST_DATABASE_URL;
const isolatedDatabase = async t => {
  assert.match(new URL(databaseUrl).pathname, /test|tmp/i, 'Use an explicitly named test database');
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `geocsv_migration_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  await db.query('CREATE TABLE file_nodes (id TEXT PRIMARY KEY)');
  t.after(async () => {
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  return db;
};
const ledger = async db => (await db.query(
  'SELECT version, applied_at FROM geocsv_analysis_migrations ORDER BY version',
)).rows;

test('PostGIS migration: upgrade legacy rows, preserve exports, and accept old writes', { skip: !databaseUrl }, async t => {
  const db = await isolatedDatabase(t);
  await db.query(LEGACY_ANALYSIS_SCHEMA);
  const definitionId = randomUUID();
  const runId = randomUUID();
  const artifactId = randomUUID();
  const originalRun = await db.query(`
    INSERT INTO geocsv_analysis_definitions(id,spec_hash,spec) VALUES($1,$2,$3);
  `, [definitionId, createHash('sha256').update(JSON.stringify(spec)).digest('hex'), spec]);
  assert.equal(originalRun.rowCount, 1);
  await db.query(`INSERT INTO geocsv_analysis_runs(id,definition_id,spec,status,artifact_id,completed_at)
    VALUES($1,$2,$3,'succeeded',$4,now())`, [runId, definitionId, spec, artifactId]);
  await db.query(`INSERT INTO geocsv_analysis_artifacts(id,run_id,spec,columns,total_rows,summary)
    VALUES($1,$2,$3,'[{"key":"c0","label":"公园"}]'::jsonb,1,'{"matchedPairs":2}'::jsonb)`, [artifactId, runId, spec]);
  await db.query(`INSERT INTO geocsv_analysis_artifact_rows(artifact_id,feature_id,label,counts,total,geom)
    VALUES($1,1,'旧街道','{"c0":2}',2,ST_GeomFromText('POLYGON((0 0,2 0,2 2,0 2,0 0))',4326))`, [artifactId]);

  await Promise.all([migrateAnalysis(db), migrateAnalysis(db)]);
  const versions = await ledger(db);
  assert.deepEqual(versions.map(row => row.version), [1, 2, 3, 4, 5]);
  const service = new AnalysisService(db);
  const app = express();
  app.use('/api', createSpatialPivotRouter(db, service));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const get = async path => {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      return response;
    };
    const run = (await (await get(`/runs/${runId}`)).json()).data;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.planId, null);
    assert.equal(run.artifactId, artifactId);
    assert.deepEqual(run.spec, spec);
    assert.equal((await (await get('/runs')).json()).data[0].id, runId);
    const artifact = (await (await get(`/artifacts/${artifactId}`)).json()).data;
    assert.equal(artifact.format, 'spatial_counts');
    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.totalRows, 1);
    assert.deepEqual((await (await get(`/artifacts/${artifactId}/rows`)).json()).data.rows,
      [{ featureId: 1, label: '旧街道', counts: { c0: 2 }, total: 2 }]);
    assert.equal((await (await get(`/artifacts/${artifactId}/geojson`)).json()).features[0].geometry.type, 'Polygon');
    assert.match(await (await get(`/artifacts/${artifactId}/export.csv`)).text(), /"旧街道","2","2"/);

    // Old INSERT column lists still work against the migrated database.
    const oldWriteId = randomUUID();
    const oldArtifactId = randomUUID();
    await db.query(`INSERT INTO geocsv_analysis_runs(id,definition_id,spec,status,artifact_id,completed_at)
      VALUES($1,$2,$3,'succeeded',$4,now())`, [oldWriteId, definitionId, spec, oldArtifactId]);
    await db.query(`INSERT INTO geocsv_analysis_artifacts(id,run_id,spec,columns,total_rows,summary)
      VALUES($1,$2,$3,'[]'::jsonb,0,'{}'::jsonb)`, [oldArtifactId, oldWriteId, spec]);
    assert.equal((await service.get(oldWriteId)).planId, null);
    assert.equal((await service.getArtifact(oldArtifactId)).format, 'spatial_counts');
    assert.deepEqual(await ledger(db), versions, 'Restart does not write another migration entry');
  } finally {
    await service.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('PostGIS migration: preserve keyed runs from the submission batch', { skip: !databaseUrl }, async t => {
  const db = await isolatedDatabase(t);
  await db.query(LEGACY_ANALYSIS_SCHEMA);
  await db.query(`ALTER TABLE geocsv_analysis_runs
    ADD COLUMN request_actor TEXT, ADD COLUMN request_scope TEXT, ADD COLUMN request_key TEXT, ADD COLUMN request_hash TEXT;
    CREATE UNIQUE INDEX geocsv_runs_request_key ON geocsv_analysis_runs(request_actor, request_scope, request_key)`);
  const definitionId = randomUUID();
  const id = randomUUID();
  const key = { actor: 'local', scope: 'runs:create', key: randomUUID() };
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await db.query('INSERT INTO geocsv_analysis_definitions(id,spec_hash,spec) VALUES($1,$2,$3)', [definitionId, digest(spec), spec]);
  await db.query(`INSERT INTO geocsv_analysis_runs
    (id,definition_id,spec,status,request_actor,request_scope,request_key,request_hash)
    VALUES($1,$2,$3,'cancelled',$4,$5,$6,$7)`,
    [id, definitionId, spec, key.actor, key.scope, key.key, digest({ spec, expectedVersions: null })]);

  const service = new AnalysisService(db);
  try {
    assert.equal((await service.create({ spec }, key)).id, id);
    assert.equal((await service.history(20)).length, 1);
    assert.deepEqual((await ledger(db)).map(row => row.version), [1, 2, 3, 4, 5]);
  } finally { await service.stop(); }
});

test('PostGIS migration: reject schema drift and roll back the ledger', { skip: !databaseUrl }, async t => {
  const db = await isolatedDatabase(t);
  await db.query(LEGACY_ANALYSIS_SCHEMA);
  await db.query(`ALTER TABLE geocsv_analysis_artifact_rows ALTER COLUMN total TYPE BIGINT`);
  await assert.rejects(migrateAnalysis(db), /基线不符/);
  const state = await db.query(`SELECT to_regclass(format('%I.geocsv_analysis_migrations', current_schema())) AS ledger,
    to_regclass(format('%I.geocsv_analysis_plans', current_schema())) AS plans`);
  assert.deepEqual(state.rows[0], { ledger: null, plans: null });
});
