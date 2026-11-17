const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const api = process.env.GEOCSV_TEST_API;
const token = process.env.GEOCSV_MODEL_ADMIN_TOKEN;
assert.match(api ?? '', /^http:\/\/127\.0\.0\.1:\d+\/api$/, 'Use the isolated local test instance');
assert.ok(token, 'Set GEOCSV_MODEL_ADMIN_TOKEN for the test instance');

const catalog = '/professional-models';
const manage = catalog + '/manage';
const operator = { id: 'spatial_autocorrelation', version: 2 };
const modelPath = model => `/${model.id}/${model.version}`;

async function request(path, { body, method, admin, status = 200, key } = {}) {
  const form = body instanceof FormData;
  const response = await fetch(api + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(admin ? { Authorization: 'Bearer ' + token } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined || form ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json();
  assert.equal(response.status, status, path + ' ' + JSON.stringify(payload));
  return response.ok ? payload.data : payload.errorCode;
}

async function upload(scene, name, values) {
  const features = [[0, 0], [1, 0], [2, 1], [10, 0]].map(([x, y], i) => ({
    type: 'Feature', properties: { name: 'ABCD'[i], value: values[i] },
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] },
  }));
  const body = new FormData();
  body.append('files', new Blob([JSON.stringify({ type: 'FeatureCollection', features })]), name + '.geojson');
  return (await request(`/scenes/${scene.id}/files/upload`, { body }))[0]._id;
}

async function terminal(id, status) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const current = await request('/runs/' + id);
    if (!['queued', 'running'].includes(current.status)) {
      assert.equal(current.status, status, JSON.stringify(current));
      return current;
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for Run ' + id);
}

async function verifyResult(run, model, expectedI) {
  assert.deepEqual(run.operator, operator);
  assert.equal(run.professionalModel.id, model.id);
  assert.equal(run.professionalModel.revision, model.revision);
  assert.equal(run.professionalModel.version, model.version);
  for (const [key, value] of Object.entries(model.parameters)) assert.equal(run.spec[key], value);
  const plan = await request('/analysis/plans/' + run.planId);
  assert.equal(plan.status, 'confirmed');
  assert.deepEqual(plan.spec, run.spec);
  const artifact = await request('/artifacts/' + run.artifactId);
  assert.equal(artifact.format, 'moran_lisa');
  assert.equal(artifact.totalRows, 4);
  assert.deepEqual(artifact.spec, run.spec);
  assert.ok(Math.abs(artifact.summary.globalI - expectedI) < 1e-12);
  return { model: run.professionalModel.name, version: model.version, runId: run.id,
    artifactId: artifact.id, globalI: artifact.summary.globalI };
}

async function main() {
  assert.equal(await request(manage, { status: 401 }), 'MODEL_ADMIN_REQUIRED');
  const suffix = randomUUID().slice(0, 8);
  const [scene, other] = await Promise.all(['模型', '隔离'].map(label =>
    request('/scenes', { body: { name: label + ' ' + suffix }, status: 201 })));
  const [sample, constant] = await Promise.all([
    upload(scene, 'four-faces', [1, 3, 5, 7]), upload(scene, 'constant', [1, 1, 1, 1]),
  ]);
  const scope = `/scenes/${scene.id}${catalog}`;
  const config = mode => ({ name: `测试 ${mode} ${suffix}`, description: mode + ' 空间自相关', operator,
    parameters: { contiguity: mode, permutations: 0, seed: 42 } });
  assert.equal(await request(manage, { admin: true, status: 400, body: {
    ...config('queen'), operator: { id: 'spatial_pivot', version: 1 },
  } }), 'UNSUPPORTED_OPERATOR');
  const create = mode => request(manage, { admin: true, status: 201, body: config(mode) });
  const publish = (model, status = 200) => request(manage + modelPath(model) + '/publish', {
    admin: true, body: { revision: model.revision }, status,
  });
  const launch = (model, purpose, { fileId = sample, path = scope, key = randomUUID(), status = 202, admin = purpose === 'trial' } = {}) =>
    request(path + modelPath(model) + '/runs', { key, status, admin,
      body: { revision: model.revision, purpose, inputs: { target: { fileId, valueField: 'value', labelField: 'name' } } },
    });
  const inCatalog = async model => (await request(catalog)).find(item => item.id === model.id);
  const queen = await create('queen');
  assert.equal(await inCatalog(queen), undefined);
  assert.equal(await launch(queen, 'run', { status: 404 }), 'MODEL_NOT_FOUND');
  assert.equal(await launch(queen, 'trial', { admin: false, status: 401 }), 'MODEL_ADMIN_REQUIRED');
  assert.equal(await launch(queen, 'trial', { path: `/scenes/${other.id}${catalog}`, status: 400 }), 'DATASET_NOT_FOUND');
  assert.equal(await publish(queen, 409), 'MODEL_TRIAL_REQUIRED');
  await terminal((await launch(queen, 'trial', { fileId: constant })).id, 'failed');
  assert.equal(await publish(queen, 409), 'MODEL_TRIAL_REQUIRED');
  const trial = await terminal((await launch(queen, 'trial')).id, 'succeeded');
  assert.equal((await publish(queen)).trialRunId, trial.id);
  assert.equal((await inCatalog(queen)).version, 1);

  const rook = await create('rook');
  await terminal((await launch(rook, 'trial')).id, 'succeeded');
  await publish(rook);
  const key = randomUUID();
  const [first, retry] = await Promise.all([launch(queen, 'run', { key }), launch(queen, 'run', { key })]);
  assert.equal(first.id, retry.id);
  const rookRun = await launch(rook, 'run');
  const results = await Promise.all([[first, queen, 0.2], [rookRun, rook, 0.6]]
    .map(async ([run, model, expectedI]) => verifyResult(await terminal(run.id, 'succeeded'), model, expectedI)));

  const next = await request(manage + modelPath(queen) + '/next', { admin: true, status: 201, method: 'POST' });
  await terminal((await launch(next, 'trial')).id, 'succeeded');
  const updated = await request(manage + modelPath(next), { admin: true, method: 'PUT',
    body: { ...config('queen'), revision: next.revision, parameters: { ...next.parameters, seed: 43 } } });
  assert.equal(await publish(next, 409), 'MODEL_REVISION_CONFLICT');
  assert.equal(await publish(updated, 409), 'MODEL_TRIAL_REQUIRED');
  assert.equal((await inCatalog(queen)).version, 1);
  await terminal((await launch(updated, 'trial')).id, 'succeeded');
  await publish(updated);
  assert.equal((await inCatalog(queen)).version, 2);
  await verifyResult(await request('/runs/' + first.id), queen, 0.2);
  const history = await request(scope + '/runs');
  assert.ok(history.some(run => run.id === rookRun.id));
  assert.deepEqual(await request(`/scenes/${other.id}${catalog}/runs`), []);
  const sceneHistory = await request(`/scenes/${scene.id}/analysis/runs`);
  assert.ok(sceneHistory.some(run => run.id === first.id));
  assert.ok(sceneHistory.every(run => run.professionalModel?.purpose !== 'trial'));
  console.log(JSON.stringify({ sceneId: scene.id, results, updatedVersion: updated.version }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
