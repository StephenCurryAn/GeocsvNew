const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const express = require('express');
const { createSpatialPivotRouter } = require('../src/modules/spatialPivot/router');
const { AnalysisService } = require('../src/modules/analysis/service');
const { queryAttributePivot } = require('../src/modules/attributePivot');
const examples = require('../../docs/contracts/analysis.examples.json');

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostGIS: plan -> persisted run -> table/map/CSV artifact; boundaries, replay and source isolation',
  { skip: !databaseUrl, timeout: 90000 }, async t => {
  const databaseName = new URL(databaseUrl).pathname;
  assert.match(databaseName, /test|tmp/i, 'Use an explicitly named test database, never the application database');
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `geocsv_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 8 });
  db.on('error', error => console.error('[test pool]', error.message));
  const service = new AnalysisService(db, 10000);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.get('X-Test-Drop-Response') === 'yes') {
      res.json = () => { res.destroy(); return res; };
    }
    next();
  });
  app.use('/api', createSpatialPivotRouter(db, service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const submit = (body, headers = {}, path = '/runs') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const request = async (path, body, expected = 200, headers = {}) => {
    const response = await (body === undefined ? fetch(base + path) : submit(body, headers, path));
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data.data;
  };
  const terminal = async id => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const run = await request(`/runs/${id}`);
      if (!['queued', 'running'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('run never reached a terminal state');
  };
  const spec = examples.SpatialPivotSpec;
  try {
    await db.query(readFileSync(join(__dirname, '../src/config/init.sql'), 'utf8'));
    await db.query(`INSERT INTO file_nodes(id,name,type) VALUES
      ('districts','same.geojson','file'), ('pois','same.geojson','file'), ('empty','empty.geojson','file')`);
    const feature = async (fileId, wkt, properties) => db.query(`
      INSERT INTO spatial_features(file_id,geom,properties) VALUES($1,ST_GeomFromText($2,4326),$3)`, [fileId, wkt, properties]);
    await feature('districts', 'POLYGON((0 0,2 0,2 2,0 2,0 0))', { id: 'duplicate', name: 'same' });
    await feature('districts', 'POLYGON((2 0,4 0,4 2,2 2,2 0))', { id: 'duplicate', name: 'same' });
    await feature('districts', 'POLYGON((5 0,6 0,6 1,5 1,5 0))', { id: 'third', name: '=SUM(A1)', laterField: 'found' });
    await feature('pois', 'POINT(1 1)', { id: 'duplicate', category: 'park', value: 0, "O'Brien": 1 });
    await feature('pois', 'POINT(1.5 1)', { id: 'duplicate', category: '__proto__', value: 2 });
    await feature('pois', 'POINT(2 1)', { category: 'park', value: 4 });
    await feature('pois', 'POINT(3 1)', { category: null, value: 6 });
    await feature('pois', 'POINT(10 10)', { category: 'outside', value: 8 });
    const before = await db.query('SELECT id, properties, ST_AsText(geom) AS geom FROM spatial_features ORDER BY id');
    const datasets = await request('/datasets?ids=districts,pois');
    assert.ok(datasets[0].fields.includes('laterField'), 'Schema includes fields beyond the first record');
    assert.equal(datasets[0].fileId, 'districts');
    assert.equal(datasets[1].fileId, 'pois');
    assert.deepEqual(await request('/analysis-plans', spec), spec);
    assert.deepEqual((await request('/operators')).find(operator => operator.id === examples.Operator.id), examples.Operator);
    await service.start();
    const freshLedger = (await db.query('SELECT version FROM geocsv_analysis_migrations ORDER BY version')).rows;
    assert.deepEqual(freshLedger.map(row => row.version), [1, 2, 3, 4, 5]);
    const beforePlanning = Number((await db.query('SELECT count(*) FROM geocsv_analysis_runs')).rows[0].count);
    const natural = await request('/analysis-plans/natural-language', {
      userPrompt: '按category分类统计每个街道内设施数量，排除边界', fileIds: ['districts', 'pois'],
    });
    assert.equal(natural.status, 'ready');
    assert.equal(natural.source, 'rules');
    assert.deepEqual(natural.spec, spec, 'Form and natural language produce the same validated protocol');
    assert.deepEqual(natural.plan.spec, spec);
    assert.equal(natural.plan.status, 'validated');
    assert.equal(natural.plan.confirmedAt, null);
    assert.deepEqual(await request(`/analysis/plans/${natural.plan.id}`), natural.plan);
    assert.equal(Number((await db.query('SELECT count(*) FROM geocsv_analysis_runs')).rows[0].count), beforePlanning, 'Planning never creates a run');
    const header = { 'Idempotency-Key': randomUUID() };
    const submitRun = (specification, headers = header) => request('/runs', { spec: specification }, 202, headers);
    const [first, concurrent] = await Promise.all([
      submitRun(natural.spec),
      submitRun({ boundaryPolicy: spec.boundaryPolicy, ...spec }),
    ]);
    assert.equal(concurrent.id, first.id);
    assert.equal((await db.query('SELECT count(*) FROM geocsv_analysis_runs')).rows[0].count, '1');
    const naturalRun = await terminal(first.id);
    const conflict = await submit({ spec: { ...spec, boundaryPolicy: 'include' } }, header);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).errorCode, 'IDEMPOTENCY_KEY_CONFLICT');
    const invalidKey = await submit({ spec }, { 'Idempotency-Key': 'invalid key' });
    assert.equal(invalidKey.status, 400);
    const recomputeKey = { 'Idempotency-Key': randomUUID() };
    await assert.rejects(submit({ spec }, { ...recomputeKey, 'X-Test-Drop-Response': 'yes' }), /fetch failed/);
    const persisted = (await db.query('SELECT id FROM geocsv_analysis_runs WHERE request_key=$1',
      [recomputeKey['Idempotency-Key']])).rows[0];
    assert.ok(persisted, 'The server accepted the request before the socket closed');
    const recomputed = await submitRun(spec, recomputeKey);
    assert.equal(recomputed.id, persisted.id);
    assert.notEqual(recomputed.id, naturalRun.id);
    assert.equal((await db.query('SELECT count(*) FROM geocsv_analysis_runs')).rows[0].count, '2');
    assert.deepEqual((await request(`/artifacts/${(await terminal(recomputed.id)).artifactId}/rows`)).rows.map(row => row.total), [2, 1, 0]);
    t.diagnostic(`same-key Run ${naturalRun.id}, recompute Run ${recomputed.id} (dropped HTTP response recovered)`);
    assert.equal(naturalRun.status, 'succeeded', naturalRun.error);
    assert.deepEqual((await request(`/artifacts/${naturalRun.artifactId}/rows`)).rows.map(row => row.total), [2, 1, 0]);
    const beforeView = Number((await db.query('SELECT count(*) FROM geocsv_analysis_runs')).rows[0].count);
    const view = await request('/analysis-plans/natural-language', {
      userPrompt: '把上次结果换成饼图', fileIds: [], contextRunId: naturalRun.id,
    });
    assert.equal(view.status, 'view_only');
    assert.equal(view.artifactId, naturalRun.artifactId);
    assert.equal(view.view.chartType, 'pie');
    const unsupported = await request('/analysis-plans/natural-language', {
      userPrompt: '统计街道周边500米设施数量', fileIds: ['districts', 'pois'],
    });
    assert.equal(unsupported.status, 'unsupported');
    assert.equal(Number((await db.query('SELECT count(*) FROM geocsv_analysis_runs')).rows[0].count), beforeView, 'Views and unsupported requests never create a run');
    await request('/analysis-plans', { ...spec, target: { ...spec.target, labelField: 'missing' } }, 400);
    await request('/analysis-plans', { ...spec, boundaryPolicy: 'guess' }, 400);
    const plan = await request('/analysis/plans', examples.CreatePlan, 201);
    assert.deepEqual(Object.keys(plan).sort(), Object.keys(examples.Plan).sort());
    assert.deepEqual(plan.operator, { id: spec.kind, version: spec.operatorVersion });
    assert.equal(plan.version, 1);
    assert.equal(plan.status, 'validated');
    assert.match(plan.specHash, /^[a-f0-9]{64}$/);
    assert.equal(plan.inputVersions.join.count, 5);
    const planRequest = { planId: plan.id, planVersion: plan.version };
    const planKey = { 'Idempotency-Key': randomUUID() };
    const expectFailure = async (path, body, status, errorCode, headers) => {
      const response = await submit(body, headers, path);
      assert.equal(response.status, status);
      assert.equal((await response.json()).errorCode, errorCode);
    };
    await expectFailure('/analysis/plans', { spec: { ...spec, unknown: true } }, 400, 'INVALID_SPEC');
    await expectFailure('/analysis/plans', { spec: { ...spec, kind: 'unsupported' } }, 400, 'UNSUPPORTED_OPERATOR');
    await expectFailure('/analysis/plans', { spec: { ...spec, join: { fileId: 'missing' } } }, 400, 'DATASET_NOT_FOUND');
    await expectFailure('/analysis/plans', { spec: { ...spec, target: { fileId: 'pois' }, join: { fileId: 'districts' } } }, 400, 'INVALID_GEOMETRY');
    await expectFailure('/analysis/plans', { spec: { ...spec, join: { ...spec.join, categoryField: 'missing' } } }, 400, 'UNKNOWN_FIELD');
    await expectFailure('/runs', planRequest, 400, 'INVALID_REQUEST');
    await expectFailure('/runs', planRequest, 409, 'IDEMPOTENCY_KEY_CONFLICT', header);
    await expectFailure('/runs', { ...planRequest, planVersion: 2 }, 409, 'PLAN_VERSION_CONFLICT', planKey);
    await expectFailure('/runs', { ...planRequest, planId: randomUUID() }, 404, 'PLAN_NOT_FOUND', planKey);

    const [confirmed, duplicateConfirmation] = await Promise.all([
      request('/runs', planRequest, 202, planKey),
      request('/runs', planRequest, 202, planKey),
    ]);
    assert.equal(confirmed.id, duplicateConfirmation.id);
    assert.equal(confirmed.planId, plan.id);
    assert.deepEqual(confirmed.inputVersions, plan.inputVersions);
    assert.equal((await db.query('SELECT count(*) FROM geocsv_analysis_runs WHERE plan_id=$1', [plan.id])).rows[0].count, '1');
    await expectFailure('/runs', { ...planRequest, planVersion: 2 }, 409, 'IDEMPOTENCY_KEY_CONFLICT', planKey);
    const confirmAgain = { 'Idempotency-Key': randomUUID() };
    await assert.rejects(submit(planRequest, { ...confirmAgain, 'X-Test-Drop-Response': 'yes' }), /fetch failed/);
    const acceptedAgain = (await db.query('SELECT id FROM geocsv_analysis_runs WHERE request_key=$1',
      [confirmAgain['Idempotency-Key']])).rows[0];
    assert.ok(acceptedAgain);
    assert.equal((await request('/runs', planRequest, 202, confirmAgain)).id, acceptedAgain.id);
    assert.notEqual(acceptedAgain.id, confirmed.id);
    const confirmedPlan = await request(`/analysis/plans/${plan.id}`);
    assert.equal(confirmedPlan.status, 'confirmed');
    assert.ok(confirmedPlan.confirmedAt);

    const run = await terminal(confirmed.id);
    assert.deepEqual(Object.keys(run).sort(), Object.keys(examples.Run).sort());
    assert.equal(run.status, 'succeeded', run.error);
    assert.ok(run.inputVersions.target.fingerprint);
    const artifact = await request(`/artifacts/${run.artifactId}`);
    assert.deepEqual(Object.keys(artifact).sort(), Object.keys(examples.Artifact).sort());
    assert.equal(artifact.totalRows, 3);
    assert.equal(artifact.format, 'spatial_counts');
    assert.equal(artifact.schemaVersion, 1);
    assert.deepEqual(artifact.operator, plan.operator);
    t.diagnostic(`confirmed plan ${plan.id}, Run ${run.id}, Artifact ${artifact.id}, totals [2,1,0]`);
    assert.equal(artifact.summary.matchedPairs, 3);
    const page = await request(`/artifacts/${run.artifactId}/rows?page=1&pageSize=20`);
    assert.deepEqual(page, examples.SpatialCountsPage);
    assert.equal(new Set(page.rows.map(row => row.featureId)).size, 3);
    const mapResponse = await fetch(`${base}/artifacts/${run.artifactId}/geojson`);
    const geojson = await mapResponse.json();
    assert.equal(geojson.features.length, 3);
    assert.deepEqual(geojson.features.map(item => item.properties.total), [2, 1, 0]);
    assert.equal(geojson.features[0].geometry.type, 'Polygon');
    const csv = await (await fetch(`${base}/artifacts/${run.artifactId}/export.csv`)).text();
    assert.ok(csv.includes("'=SUM(A1)"), 'Spreadsheet formulas in labels are escaped');
    assert.equal(csv.trim().split('\n').length, 4);
    await request(`/artifacts/${run.artifactId}/rows?page=-1`, undefined, 400);
    await request('/runs/not-a-uuid', undefined, 400);

    const replay = await terminal((await request(`/runs/${run.id}/replay`, {}, 202, header)).id);
    assert.notEqual(replay.id, naturalRun.id, 'Replay and create have separate scopes');
    assert.equal((await request(`/runs/${run.id}/replay`, {}, 202, header)).id, replay.id);
    assert.equal(replay.status, 'succeeded', replay.error);
    const replayRows = await request(`/artifacts/${replay.artifactId}/rows`);
    assert.deepEqual(replayRows.rows, page.rows);
    const inclusive = await terminal((await request('/runs', { spec: { ...spec, boundaryPolicy: 'include' } }, 202)).id);
    assert.equal(inclusive.status, 'succeeded', inclusive.error);
    assert.deepEqual((await request(`/artifacts/${inclusive.artifactId}/rows`)).rows.map(row => row.total), [3, 2, 0]);
    const empty = await terminal((await request('/runs', { spec: { ...spec, join: { fileId: 'empty', categoryField: null } } }, 202)).id);
    assert.equal(empty.status, 'succeeded', empty.error);
    assert.deepEqual((await request(`/artifacts/${empty.artifactId}/rows`)).rows.map(row => row.total), [0, 0, 0]);
    assert.deepEqual((await db.query('SELECT id, properties, ST_AsText(geom) AS geom FROM spatial_features ORDER BY id')).rows, before.rows);

    const quotePivot = await queryAttributePivot(db, { fileId: 'pois', groupByRow: 'category', valueField: "O'Brien", method: 'sum' });
    assert.ok(quotePivot.success);
    const injection = await queryAttributePivot(db, { fileId: 'pois', groupByRow: "x'); DROP TABLE file_nodes; --", method: 'count' });
    assert.equal(injection.data[0].value, 5);
    assert.equal((await db.query('SELECT count(*) FROM file_nodes')).rows[0].count, '3');
    const zero = await queryAttributePivot(db, { fileId: 'pois', groupByRow: 'id', valueField: 'value', method: 'sum' });
    assert.equal(zero.data.find(row => row.rowKey === 'duplicate').value, 2);
    await feature('pois', 'POINT(10 10)', { category: '未分类', value: 0 });
    const missing = await queryAttributePivot(db, { fileId: 'pois', groupByRow: 'category', method: 'count' });
    assert.equal(missing.data.find(row => row.rowKey === '未分类').value, 1);
    assert.equal(missing.data.find(row => row.rowKey === '未分类（空值）').value, 1);

    const stalePlan = await request('/analysis/plans', { spec }, 201);
    await db.query(`UPDATE spatial_features SET properties=properties || '{"changed":true}'::jsonb WHERE file_id='pois'`);
    const staleRequest = { planId: stalePlan.id, planVersion: stalePlan.version };
    const staleKey = { 'Idempotency-Key': randomUUID() };
    await expectFailure('/runs', staleRequest, 409, 'INPUT_VERSION_CHANGED', staleKey);
    assert.equal((await request(`/analysis/plans/${stalePlan.id}`)).status, 'validated');
    assert.equal((await db.query('SELECT count(*) FROM geocsv_analysis_runs WHERE plan_id=$1', [stalePlan.id])).rows[0].count, '0');
    assert.equal((await request('/runs', planRequest, 202, planKey)).id, run.id, 'Confirmed retries bypass source revalidation');
    const refreshedPlan = await request('/analysis/plans', { spec }, 201);
    assert.notEqual(refreshedPlan.inputVersions.join.fingerprint, stalePlan.inputVersions.join.fingerprint);
    const refreshedRun = await request('/runs', { planId: refreshedPlan.id, planVersion: refreshedPlan.version }, 202, staleKey);
    assert.equal((await terminal(refreshedRun.id)).status, 'succeeded', 'A rejected confirmation leaves its key available');
    assert.equal((await submitRun(spec)).id, naturalRun.id, 'A retry returns its accepted Run after inputs change');
    const changed = await terminal((await request(`/runs/${run.id}/replay`, {}, 202)).id);
    assert.equal(changed.status, 'failed');
    assert.match(changed.error, /数据已改变/);
    assert.equal(changed.errorCode, 'INPUT_VERSION_CHANGED');
    assert.deepEqual((await request(`/artifacts/${run.artifactId}/rows`)).rows, page.rows);

    const hold = await db.connect();
    await hold.query('SELECT pg_advisory_lock(193607241)');
    const queued = await request('/runs', { spec }, 202);
    assert.ok(queued.inputVersions.target.fingerprint, 'Submission fixes input versions before entering the queue');
    assert.equal((await request(`/runs/${queued.id}/cancel`, {})).status, 'cancelled');
    const waiting = await request('/runs', { spec }, 202);
    await db.query(`UPDATE spatial_features SET properties=properties || '{"queuedEdit":true}'::jsonb WHERE file_id='pois'`);
    await hold.query('SELECT pg_advisory_unlock(193607241)');
    hold.release();
    assert.equal((await terminal(queued.id)).status, 'cancelled');
    const changedWhileQueued = await terminal(waiting.id);
    assert.equal(changedWhileQueued.status, 'failed');
    assert.match(changedWhileQueued.error, /数据已改变/);
    assert.equal(changedWhileQueued.errorCode, 'INPUT_VERSION_CHANGED');
    assert.equal(changedWhileQueued.artifactId, null);

    // A real, cancellable database operation, not a mocked HTTP status.
    await db.query(`CREATE FUNCTION pause_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER slow_artifact BEFORE INSERT ON geocsv_analysis_artifacts
      FOR EACH ROW EXECUTE FUNCTION pause_artifact()`);
    const running = await request('/runs', { spec }, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      const active = await db.query(`SELECT a.wait_event FROM geocsv_analysis_runs r
        JOIN pg_stat_activity a ON a.pid=r.backend_pid WHERE r.id=$1`, [running.id]);
      if (active.rows[0]?.wait_event === 'PgSleep') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await request(`/runs/${running.id}/cancel`, {});
    assert.equal((await terminal(running.id)).status, 'cancelled');
    assert.equal((await db.query('SELECT count(*) FROM geocsv_analysis_artifacts WHERE run_id=$1', [running.id])).rows[0].count, '0');
    const disconnected = await request('/runs', { spec }, 202);
    for (let attempt = 0; attempt < 100; attempt++) {
      const active = await db.query(`SELECT r.backend_pid,a.wait_event FROM geocsv_analysis_runs r
        JOIN pg_stat_activity a ON a.pid=r.backend_pid WHERE r.id=$1`, [disconnected.id]);
      if (active.rows[0]?.wait_event === 'PgSleep') {
        await admin.query('SELECT pg_terminate_backend($1)', [active.rows[0].backend_pid]);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const interrupted = await terminal(disconnected.id).catch(error => { throw new Error('Connection recovery polling failed', { cause: error }); });
    assert.equal(interrupted.status, 'failed', 'Lost worker connections must recover without restarting the API');
    assert.equal(interrupted.artifactId, null);
    assert.equal(interrupted.errorCode, 'WORKER_INTERRUPTED');
    await db.query('DROP TRIGGER slow_artifact ON geocsv_analysis_artifacts');
    const healthy = await terminal((await request('/runs', { spec }, 202)).id);
    assert.equal(healthy.status, 'succeeded', healthy.error);
    assert.ok((await request('/runs')).length >= 6);
  } finally {
    await service.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
