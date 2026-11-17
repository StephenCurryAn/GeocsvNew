const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const express = require('express');
const { AnalysisService } = require('../src/modules/analysis/service');
const { createAnalysisRouter } = require('../src/modules/analysis/router');

const databaseUrl = process.env.TEST_DATABASE_URL;
const serverRoot = resolve(__dirname, '..');
const projectRoot = resolve(serverRoot, '..');
const python = resolve(projectRoot, 'python_engine/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function isolatedDatabase(t) {
  assert.match(new URL(databaseUrl).pathname, /test|tmp/i, 'Use a dedicated test database');
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const schema = 'geocsv_moran_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA "' + schema + '"');
  const db = new Pool({ connectionString: databaseUrl, options: '-c search_path=' + schema + ',public', max: 8 });
  t.after(async () => {
    await db.end();
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  });
  const fs = require('node:fs');
  await db.query(fs.readFileSync(join(serverRoot, 'src/config/init.sql'), 'utf8'));
  await db.query("INSERT INTO file_nodes(id,name,type) VALUES ('four-faces','four-faces.geojson','file')");
  const features = [
    ['A', 'POLYGON((0 0,1 0,1 1,0 1,0 0))', 1],
    ['B', 'POLYGON((1 0,2 0,2 1,1 1,1 0))', 3],
    ['C', 'POLYGON((2 1,3 1,3 2,2 2,2 1))', 5],
    ['D', 'POLYGON((10 0,11 0,11 1,10 1,10 0))', 7],
  ];
  for (const [id, polygon, value] of features) {
    await db.query(
      'INSERT INTO spatial_features(file_id,geom,properties) VALUES ($1,ST_GeomFromText($2,4326),$3)',
      ['four-faces', polygon, { id, value }],
    );
  }
  return { db, schema };
}

function makeApp(db, timeoutMs = 30000) {
  const service = new AnalysisService(db, timeoutMs);
  const app = express();
  app.use(express.json());
  app.use('/api', createAnalysisRouter(db, service));
  return { app, service };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, base: 'http://127.0.0.1:' + server.address().port + '/api' };
}

async function request(base, path, options = {}) {
  const headers = options.body === undefined
    ? (options.headers || {})
    : { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(base + path, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  assert.equal(response.status, options.expected || 200, JSON.stringify(data));
  return data.data;
}

const specFor = contiguity => ({
  schemaVersion: 1,
  kind: 'spatial_autocorrelation',
  operatorVersion: 2,
  target: { fileId: 'four-faces', valueField: 'value' },
  contiguity,
  permutations: contiguity === 'queen' ? 4 : 0,
  seed: 42,
});

async function waitForTerminal(base, id, timeoutMs = 60000) {
  let lastRun;
  for (let attempt = 0; attempt * 25 < timeoutMs; attempt++) {
    lastRun = await request(base, '/runs/' + id);
    if (lastRun.status !== 'queued' && lastRun.status !== 'running') return lastRun;
    await delay(25);
  }
  throw new Error('Run did not reach a terminal state after ' + timeoutMs + ' ms: ' + JSON.stringify(lastRun));
}

async function checkArtifact(base, run, contiguity) {
  assert.equal(run.status, 'succeeded', run.error);
  assert.ok(run.artifactId);
  const artifact = await request(base, '/artifacts/' + run.artifactId);
  assert.equal(artifact.runId, run.id);
  assert.equal(artifact.format, 'moran_lisa');
  assert.equal(artifact.schemaVersion, 1);
  assert.deepEqual(artifact.spec, run.spec);
  assert.equal(artifact.totalRows, 4);
  assert.equal(artifact.summary.contiguity, contiguity);
  assert.equal(artifact.summary.pValue, contiguity === 'queen' ? 2 / 5 : null);
  assert.ok(Math.abs(artifact.summary.globalI - (contiguity === 'queen' ? 0.2 : 0.6)) <= 1e-12);
  assert.equal(artifact.summary.algorithmVersion, 'moran-lisa/2.0.0');
  assert.equal(artifact.summary.executionId, run.id);
  assert.match(artifact.summary.inputDigest, /^[a-f0-9]{64}$/);
  assert.match(artifact.summary.dependencyLockDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(artifact.summary.excludedValueIds, []);
  assert.equal(run.inputVersions.target.count, 4);
  assert.ok(run.inputVersions.target.fingerprint);
  assert.equal(artifact.summary.inputDigest, run.inputVersions.target.fingerprint);

  const page = await request(base, '/artifacts/' + run.artifactId + '/rows?pageSize=20');
  assert.equal(page.total, 4);
  assert.deepEqual(page.rows.map(row => row.featureId), [1, 2, 3, 4]);
  const rows = new Map(page.rows.map(row => [row.featureId, row]));
  const expectedDegrees = contiguity === 'queen' ? [1, 2, 1, 0] : [1, 1, 0, 0];
  expectedDegrees.forEach((degree, index) => assert.equal(rows.get(index + 1).neighborCount, degree));
  for (const row of page.rows.filter(row => row.neighborCount > 0)) {
    assert.equal(typeof row.localI, 'number');
    const expectedP = contiguity === 'queen' ? [4 / 5, 4 / 5, 1][row.featureId - 1] : null;
    assert.equal(row.pValue, expectedP);
    assert.ok(['HH', 'HL', 'LH', 'LL'].includes(row.quadrant));
  }
  for (const row of page.rows.filter(row => row.neighborCount === 0)) {
    assert.equal(row.pValue, null);
    assert.equal(row.quadrant, null);
  }

  const geoResponse = await fetch(base + '/artifacts/' + run.artifactId + '/geojson');
  assert.equal(geoResponse.status, 200);
  const geojson = await geoResponse.json();
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, 4);
  assert.deepEqual(geojson.features.map(feature => feature.properties.featureId), [1, 2, 3, 4]);
  return artifact;
}

test('PostGIS Python Moran runs Queen and Rook from plans through history and artifacts',
  { skip: !databaseUrl, timeout: 120000 }, async t => {
  const { db } = await isolatedDatabase(t);
  const spool = await mkdtemp(join(require('node:os').tmpdir(), 'geocsv-moran-'));
  const oldDirectory = process.env.ANALYSIS_WORKER_DIR;
  const oldPython = process.env.ANALYSIS_PYTHON;
  process.env.ANALYSIS_WORKER_DIR = spool;
  process.env.ANALYSIS_PYTHON = python;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.ANALYSIS_WORKER_DIR;
    else process.env.ANALYSIS_WORKER_DIR = oldDirectory;
    if (oldPython === undefined) delete process.env.ANALYSIS_PYTHON;
    else process.env.ANALYSIS_PYTHON = oldPython;
  });
  t.after(() => rm(spool, { recursive: true, force: true }));

  const { app, service } = makeApp(db);
  const { server, base } = await listen(app);
  await service.start();
  t.after(async () => {
    await service.stop();
    await new Promise(resolve => server.close(resolve));
  });

  for (const contiguity of ['queen', 'rook']) {
    const spec = specFor(contiguity);
    const plan = await request(base, '/analysis/plans', {
      method: 'POST', body: { spec }, expected: 201,
    });
    assert.deepEqual(plan.operator, { id: 'spatial_autocorrelation', version: 2 });
    assert.equal(plan.spec.contiguity, contiguity);
    assert.equal(plan.inputVersions.target.count, 4);

    const key = randomUUID();
    const headers = { 'Idempotency-Key': key };
    const [submitted, duplicate] = await Promise.all([
      request(base, '/runs', {
        method: 'POST', body: { planId: plan.id, planVersion: plan.version }, headers, expected: 202,
      }),
      request(base, '/runs', {
        method: 'POST', body: { planId: plan.id, planVersion: plan.version }, headers, expected: 202,
      }),
    ]);
    assert.equal(duplicate.id, submitted.id);
    assert.ok(['queued', 'running', 'succeeded'].includes(submitted.status));
    assert.equal(submitted.planId, plan.id);

    const conflict = await fetch(base + '/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ spec: { ...spec, seed: 43 } }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).errorCode, 'IDEMPOTENCY_KEY_CONFLICT');

    const run = await waitForTerminal(base, submitted.id, 90000);
    const artifact = await checkArtifact(base, run, contiguity);
    assert.equal((await request(base, '/runs/' + run.id)).artifactId, run.artifactId);
    const history = await request(base, '/runs?limit=20&operator=spatial_autocorrelation');
    assert.ok(history.some(item => item.id === run.id && item.artifactId === run.artifactId));
    assert.equal(artifact.summary.contiguity, contiguity);

    const inputDigest = artifact.summary.inputDigest;
    await db.query("UPDATE spatial_features SET properties=jsonb_set(properties,'{value}','99'::jsonb) WHERE file_id='four-faces' AND properties->>'id'='A'");
    const replay = await request(base, '/runs/' + run.id + '/replay', {
      method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, expected: 202,
    });
    const replayed = await waitForTerminal(base, replay.id);
    const replayedArtifact = await checkArtifact(base, replayed, contiguity);
    assert.equal(replayedArtifact.summary.inputDigest, inputDigest);
    t.diagnostic(JSON.stringify({ contiguity, planId: plan.id, runId: run.id, artifactId: run.artifactId,
      globalI: artifact.summary.globalI, pValue: artifact.summary.pValue, inputDigest, replayRunId: replayed.id }));

    await db.query(`UPDATE geocsv_analysis_snapshots SET expires_at=now() - interval '1 second'
      WHERE id=(SELECT snapshot_id FROM geocsv_analysis_runs WHERE id=$1)`, [run.id]);
    const expired = await fetch(base + '/runs/' + run.id + '/replay', { method: 'POST' });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).errorCode, 'INPUT_SNAPSHOT_EXPIRED');
    assert.equal((await request(base, '/artifacts/' + run.artifactId)).id, run.artifactId);
    await db.query("UPDATE spatial_features SET properties=jsonb_set(properties,'{value}','1'::jsonb) WHERE file_id='four-faces' AND properties->>'id'='A'");
  }
  t.diagnostic('Queen I=0.2 and Rook I=0.6 were verified against the four-feature PostGIS layer.');
});

test('PostGIS Python Moran reports a bounded worker timeout as a failed Run',
  { skip: !databaseUrl, timeout: 60000 }, async t => {
  const { db } = await isolatedDatabase(t);
  const spool = await mkdtemp(join(require('node:os').tmpdir(), 'geocsv-moran-timeout-'));
  const oldDirectory = process.env.ANALYSIS_WORKER_DIR;
  const oldPython = process.env.ANALYSIS_PYTHON;
  process.env.ANALYSIS_WORKER_DIR = spool;
  process.env.ANALYSIS_PYTHON = python;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.ANALYSIS_WORKER_DIR;
    else process.env.ANALYSIS_WORKER_DIR = oldDirectory;
    if (oldPython === undefined) delete process.env.ANALYSIS_PYTHON;
    else process.env.ANALYSIS_PYTHON = oldPython;
  });
  t.after(() => rm(spool, { recursive: true, force: true }));

  const { app, service } = makeApp(db, 1);
  const { server, base } = await listen(app);
  await service.start();
  t.after(async () => {
    await service.stop();
    await new Promise(resolve => server.close(resolve));
  });

  const plan = await request(base, '/analysis/plans', {
    method: 'POST', body: { spec: specFor('queen') }, expected: 201,
  });
  const run = await request(base, '/runs', {
    method: 'POST',
    body: { planId: plan.id, planVersion: plan.version },
    headers: { 'Idempotency-Key': randomUUID() },
    expected: 202,
  });
  const completed = await waitForTerminal(base, run.id, 20000);
  assert.equal(completed.status, 'failed', completed.error);
  assert.equal(completed.errorCode, 'EXECUTION_TIMEOUT');
  assert.equal(completed.artifactId, null);
  const artifacts = await db.query('SELECT count(*)::integer AS count FROM geocsv_analysis_artifacts WHERE run_id=$1', [run.id]);
  assert.equal(artifacts.rows[0].count, 0);
  t.diagnostic('Run ' + run.id + ' reached failed/EXECUTION_TIMEOUT after a 1 ms subprocess deadline.');
});

test('PostGIS Python Moran cancellation wins after worker output and before Artifact commit',
  { skip: !databaseUrl, timeout: 90000 }, async t => {
  const { db } = await isolatedDatabase(t);
  const spool = await mkdtemp(join(require('node:os').tmpdir(), 'geocsv-moran-cancel-'));
  const oldDirectory = process.env.ANALYSIS_WORKER_DIR;
  const oldPython = process.env.ANALYSIS_PYTHON;
  process.env.ANALYSIS_WORKER_DIR = spool;
  process.env.ANALYSIS_PYTHON = python;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.ANALYSIS_WORKER_DIR;
    else process.env.ANALYSIS_WORKER_DIR = oldDirectory;
    if (oldPython === undefined) delete process.env.ANALYSIS_PYTHON;
    else process.env.ANALYSIS_PYTHON = oldPython;
  });
  t.after(() => rm(spool, { recursive: true, force: true }));

  const { app, service } = makeApp(db, 30000);
  const { server, base } = await listen(app);
  await service.start();
  t.after(async () => {
    await service.stop();
    await new Promise(resolve => server.close(resolve));
  });

  const plan = await request(base, '/analysis/plans', {
    method: 'POST', body: { spec: specFor('queen') }, expected: 201,
  });
  const lockClient = await db.connect();
  let transactionOpen = false;
  try {
    await lockClient.query('BEGIN');
    transactionOpen = true;
    await lockClient.query('LOCK TABLE geocsv_analysis_artifacts IN ACCESS EXCLUSIVE MODE');
    const run = await request(base, '/runs', {
      method: 'POST',
      body: { planId: plan.id, planVersion: plan.version },
      headers: { 'Idempotency-Key': randomUUID() },
      expected: 202,
    });
    await waitForArchiveWait(db, spool, run.id);
    const cancelled = await request(base, '/runs/' + run.id + '/cancel', { method: 'POST' });
    assert.equal(cancelled.status, 'cancelled');
    await lockClient.query('ROLLBACK');
    transactionOpen = false;
    lockClient.release();

    await poll(async () => {
      try { await readFile(join(spool, run.id + '.json')); return false; }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    }, 'Node to discard the cancelled result');
    const completed = await waitForTerminal(base, run.id, 20000);
    assert.equal(completed.status, 'cancelled');
    assert.equal(completed.artifactId, null);
    const artifacts = await db.query('SELECT count(*)::integer AS count FROM geocsv_analysis_artifacts WHERE run_id=$1', [run.id]);
    assert.equal(artifacts.rows[0].count, 0);
    t.diagnostic('Late worker output was discarded after Run ' + run.id + ' was cancelled.');
  } finally {
    if (transactionOpen) {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
    }
  }
});

function waitForClose(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function startFixture(directory, schema, interpreter = python) {
  const fixturePath = join(__dirname, 'moranRecoveryServer.cjs');
  const child = spawn(process.execPath, ['-r', 'ts-node/register', fixturePath], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      TEST_DATABASE_URL: databaseUrl,
      TEST_SCHEMA: schema,
      ANALYSIS_WORKER_DIR: directory,
      ANALYSIS_PYTHON: interpreter,
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out: ' + output)), 30000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(value => value.startsWith('ready:'));
      if (line) {
        clearTimeout(timer);
        resolve(Number(line.slice(6)));
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error('Fixture exited before readiness: ' + (code || signal) + '\n' + output));
    });
  });
  try {
    const actualPort = await ready;
    return { child, base: 'http://127.0.0.1:' + actualPort + '/api' };
  } catch (error) {
    child.kill('SIGKILL');
    await waitForClose(child);
    throw error;
  }
}

async function poll(check, message, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for ' + message);
}

async function waitForArchiveWait(db, directory, id) {
  const resultPath = join(directory, id + '.json');
  await poll(async () => {
    try { return (await readFile(resultPath, 'utf8')).length > 0; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'the completed Python result');
  await poll(async () => {
    const waiting = await db.query(`SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE relation='geocsv_analysis_artifacts'::regclass AND NOT granted AND mode='RowExclusiveLock'
    ) AS waiting`);
    return waiting.rows[0].waiting;
  }, 'Node to reach artifact archival');
}

test('PostGIS Python Moran recovers the durable worker result after Node restarts',
  { skip: !databaseUrl, timeout: 120000 }, async t => {
  const { db, schema } = await isolatedDatabase(t);
  const spool = await mkdtemp(join(require('node:os').tmpdir(), 'geocsv-moran-restart-'));
  t.after(() => rm(spool, { recursive: true, force: true }));

  let fixture = await startFixture(spool, schema);
  t.after(async () => {
    if (fixture?.child.exitCode === null) {
      fixture.child.kill('SIGTERM');
      await waitForClose(fixture.child);
    }
  });

  const spec = specFor('queen');
  const plan = await request(fixture.base, '/analysis/plans', {
    method: 'POST', body: { spec }, expected: 201,
  });
  const lockClient = await db.connect();
  let transactionOpen = false;
  let run;
  try {
    await lockClient.query('BEGIN');
    transactionOpen = true;
    await lockClient.query('LOCK TABLE geocsv_analysis_artifacts IN ACCESS EXCLUSIVE MODE');
    run = await request(fixture.base, '/runs', {
      method: 'POST',
      body: { planId: plan.id, planVersion: plan.version },
      headers: { 'Idempotency-Key': randomUUID() },
      expected: 202,
    });

    await waitForArchiveWait(db, spool, run.id);
    fixture.child.kill('SIGKILL');
    await waitForClose(fixture.child);
  } finally {
    if (transactionOpen) {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
    }
  }

  // Recalculation would fail because the restarted Node has no usable Python executable.
  fixture = await startFixture(spool, schema, join(spool, 'python-unavailable'));
  const recovered = await waitForTerminal(fixture.base, run.id);
  assert.equal(recovered.status, 'succeeded', recovered.error);
  assert.ok(recovered.artifactId);
  const artifact = await request(fixture.base, '/artifacts/' + recovered.artifactId);
  assert.ok(Math.abs(artifact.summary.globalI - 0.2) <= 1e-12);
  assert.equal(artifact.summary.executionId, run.id);
  assert.equal(artifact.summary.inputDigest, recovered.inputVersions.target.fingerprint);
  t.diagnostic(JSON.stringify({ recoveredRunId: recovered.id, artifactId: artifact.id,
    inputDigest: artifact.summary.inputDigest, globalI: artifact.summary.globalI }));
  const archived = await db.query(
    'SELECT count(*)::integer AS count FROM geocsv_analysis_artifacts WHERE run_id=$1', [run.id],
  );
  assert.equal(archived.rows[0].count, 1);
  t.diagnostic('Restarted with a durable Python result and blocked Artifact insert, then archived the Run once.');
});
