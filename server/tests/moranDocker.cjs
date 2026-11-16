const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const api = 'http://127.0.0.1:8082/api';
const fixture = 'FeatureCollection';
const square = (x, y) => ({ type: 'Polygon', coordinates: [
  [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]],
] });
const faces = [[0, 0], [1, 0], [2, 1], [10, 0]].map(([x, y], i) => ({
  type: 'Feature', geometry: square(x, y), properties: { id: 'ABCD'[i], value: 2 * i + 1 },
}));
const points = [[0.25, 0.25], [0.5, 0.5], [1.5, 0.5], [1, 0.5]].map(coordinates => ({
  type: 'Feature', geometry: { type: 'Point', coordinates }, properties: {},
}));
const cases = {
  queen: { globalI: 0.2, permutations: 4, degrees: [1, 2, 1, 0], localI: [0.45, 0.15, -0.15, 0] },
  rook: { globalI: 0.6, permutations: 0, degrees: [1, 1, 0, 0], localI: [0.45, 0.45, 0, 0] },
};

async function request(path, { body, status = 200, key } = {}) {
  const form = body instanceof FormData;
  const headers = body === undefined || form ? {} : { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(api + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers, body: body === undefined || form ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, status, response.ok ? path : path + ' ' + await response.text());
  return response;
}

async function data(path, options) {
  return (await (await request(path, options)).json()).data;
}

async function run(spec) {
  const plan = await data('/analysis/plans', { body: { spec }, status: 201 });
  assert.deepEqual(plan.spec, spec);
  const submission = { body: { planId: plan.id, planVersion: plan.version }, status: 202, key: randomUUID() };
  const initial = await data('/runs', submission);
  assert.equal((await data('/runs', submission)).id, initial.id);
  const deadline = Date.now() + 140000;
  while (Date.now() < deadline) {
    const current = await data('/runs/' + initial.id);
    if (current.status === 'succeeded') return current;
    assert.ok(['queued', 'running'].includes(current.status), JSON.stringify(current));
    await delay(200);
  }
  throw new Error('Run did not finish: ' + initial.id);
}

async function checkMoran(id, mode, fileId, lockDigest) {
  const sample = cases[mode];
  const run = await data('/runs/' + id);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.operator, { id: 'spatial_autocorrelation', version: 2 });
  assert.deepEqual(run.spec.target, { fileId, valueField: 'value' });
  assert.equal(run.inputVersions.target.count, 4);
  const path = '/artifacts/' + run.artifactId;
  const [artifact, page, map, csv] = await Promise.all([
    data(path), data(path + '/rows'),
    request(path + '/geojson').then(response => response.json()),
    request(path + '/export.csv').then(response => response.text()),
  ]);
  const summary = artifact.summary;
  assert.equal(artifact.format, 'moran_lisa');
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.totalRows, 4);
  assert.equal(artifact.runId, id);
  assert.deepEqual(artifact.spec, run.spec);
  assert.equal(summary.executionId, id);
  assert.equal(summary.algorithmVersion, 'moran-lisa/2.0.0');
  assert.equal(summary.dependencyLockDigest, lockDigest);
  assert.deepEqual([summary.contiguity, summary.permutations, summary.seed, summary.crs],
    [mode, sample.permutations, 42, 'EPSG:4326']);
  assert.match(summary.inputDigest, /^[a-f0-9]{64}$/);
  assert.equal(summary.inputDigest, run.inputVersions.target.fingerprint);
  assert.ok(Math.abs(summary.globalI - sample.globalI) <= 1e-12);
  assert.equal(page.total, 4);
  assert.deepEqual(page.rows.map(row => row.neighborCount), sample.degrees);
  assert.deepEqual(map.features.map(feature => feature.geometry), faces.map(face => face.geometry));
  assert.deepEqual(map.features.map(feature => feature.properties), page.rows);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^"feature_id",/);
  assert.match(lines.at(-1), /,"",""$/);
  const probability = value => typeof value === 'number' && value > 0 && value <= 1;
  assert.ok(sample.permutations ? probability(summary.pValue) : summary.pValue === null);
  page.rows.forEach((row, i) => {
    assert.ok(Math.abs(row.localI - sample.localI[i]) <= 1e-12);
    assert.ok(sample.permutations && row.neighborCount ? probability(row.pValue) : row.pValue === null);
    if (!row.neighborCount) assert.equal(row.quadrant, null);
  });
  // The exact seeded draws below apply when ID order is unchanged by lexical sorting.
  const ids = page.rows.map(row => String(row.featureId));
  if (mode === 'queen' && ids.join() === [...ids].sort().join()) {
    assert.equal(summary.pValue, 0.4);
    assert.deepEqual(page.rows.map(row => row.pValue), [0.8, 0.8, 1, null]);
  }
  return {
    runId: id, artifactId: artifact.id, planId: run.planId, globalI: summary.globalI, pValue: summary.pValue,
    neighborCounts: sample.degrees, localPValues: page.rows.map(row => row.pValue), inputDigest: summary.inputDigest,
  };
}

async function checkCount(id) {
  const run = await data('/runs/' + id);
  assert.equal(run.status, 'succeeded');
  const path = '/artifacts/' + run.artifactId;
  assert.equal((await data(path)).format, 'spatial_counts');
  const totals = (await data(path + '/rows')).rows.map(row => row.total);
  assert.deepEqual(totals, [2, 1, 0, 0]);
  return { runId: id, artifactId: run.artifactId, totals };
}

async function submitExamples() {
  const scene = await data('/scenes', { body: { name: 'Docker Moran/LISA ' + randomUUID() }, status: 201 });
  const uploads = new FormData();
  for (const [name, features] of [['faces', faces], ['points', points]]) {
    uploads.append('files', new Blob([JSON.stringify({ type: fixture, features })]), name + '.geojson');
  }
  const files = await data('/scenes/' + scene.id + '/files/upload', { body: uploads });
  assert.deepEqual(files.map(file => file.totalFeatures), [4, 4]);
  const [fileId, pointFileId] = files.map(file => file._id);
  const spec = { schemaVersion: 1, kind: 'spatial_autocorrelation', operatorVersion: 2,
    target: { fileId, valueField: 'value' }, seed: 42 };
  const queen = await run({ ...spec, contiguity: 'queen', permutations: cases.queen.permutations });
  const rook = await run({ ...spec, contiguity: 'rook', permutations: cases.rook.permutations });
  const count = await run({ schemaVersion: 1, kind: 'spatial_pivot', operatorVersion: 1,
    target: { fileId, labelField: 'id' }, join: { fileId: pointFileId, categoryField: null }, boundaryPolicy: 'exclude' });
  return { sceneId: scene.id, fileId, queen: { runId: queen.id }, rook: { runId: rook.id }, count: { runId: count.id } };
}

async function main() {
  assert.ok(process.argv.length <= 3, 'Pass one previous JSON report to verify persistence');
  const previous = process.argv[2] && JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
  const sample = previous || await submitExamples();
  const { sceneId, fileId } = sample;
  assert.ok((await data('/scenes')).some(scene => scene.id === sceneId));
  const [uploaded, history, lock] = await Promise.all([
    data('/scenes/' + sceneId + '/files/' + fileId + '/data'),
    data('/runs?operator=spatial_autocorrelation'),
    readFile(join(__dirname, '../../python_engine/uv.lock'), 'utf8'),
  ]);
  assert.deepEqual(uploaded.features.map(feature => feature.properties.value), [1, 3, 5, 7]);
  const lockDigest = createHash('sha256').update(lock.replace(/\r\n/g, '\n')).digest('hex');
  const [queen, rook, count] = await Promise.all([
    checkMoran(sample.queen.runId, 'queen', fileId, lockDigest),
    checkMoran(sample.rook.runId, 'rook', fileId, lockDigest),
    checkCount(sample.count.runId),
  ]);
  assert.equal(queen.inputDigest, rook.inputDigest);
  for (const result of [queen, rook]) {
    assert.ok(history.some(item => item.id === result.runId && item.artifactId === result.artifactId));
  }
  const report = { sceneId, fileId, queen, rook, count };
  if (previous) assert.deepEqual(report, previous);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
