const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const { createScenePlannerRouter } = require('../src/modules/analysisPlanner/sceneRouter');

const sceneId = '11111111-1111-4111-8111-111111111111';
const otherSceneId = '11111111-1111-4111-8111-111111111112';
const areaId = '22222222-2222-4222-8222-222222222222';
const pointId = '22222222-2222-4222-8222-222222222223';
const outsideId = '22222222-2222-4222-8222-222222222224';
const files = new Map([
  [areaId, { name: '社区.geojson', scene: sceneId, type: 'ST_Polygon',
    fields: { 名称: false, pothole_requests: true, total_requests: true } }],
  [pointId, { name: '设施.geojson', scene: sceneId, type: 'ST_Point', fields: { 类型: false } }],
  [outsideId, { name: '其他场景.geojson', scene: otherSceneId, type: 'ST_Polygon', fields: { total_requests: true } }],
]);
const moranDraft = () => ({
  status: 'ready',
  spec: {
    schemaVersion: 1, kind: 'spatial_autocorrelation', operatorVersion: 2,
    target: { fileId: 'layer_1', valueField: 'total_requests' },
    contiguity: 'rook', permutations: 199, seed: 42,
  },
});
const prompt = '用社区图层的 total_requests 做 Moran/LISA，Rook 共边邻接，199 次置换';

function catalog() {
  return {
    async query(sql, [id, ids]) {
      let rows;
      const file = files.get(id);
      if (sql.includes('FROM scenes')) rows = [sceneId, otherSceneId].includes(id) ? [{}] : [];
      else if (sql.includes('scene_id')) {
        rows = [...files].filter(([key, item]) => item.scene === id && (!ids || ids.includes(key)))
          .map(([key]) => ({ id: key }));
      } else if (sql.includes('ST_GeometryType')) rows = [{ count: 77, types: [file.type] }];
      else if (sql.includes('jsonb_each')) {
        rows = Object.entries(file.fields).map(([key, numeric]) => ({ key, numeric }));
      } else if (sql.includes('id, name FROM file_nodes')) rows = [{ id, name: file.name }];
      else throw new Error('Unexpected catalog query');
      return { rows, rowCount: rows.length };
    },
  };
}

test('scene planner scopes metadata and persists only validated plans', async t => {
  const saved = [];
  const calls = [];
  let providerResponse = moranDraft();
  let providerStatus = 200;
  const agent = express();
  agent.use(express.json());
  agent.post('/plan', (req, res) => {
    calls.push({ authorization: req.get('authorization'), body: req.body });
    if (typeof providerResponse === 'string') return res.status(providerStatus).send(providerResponse);
    return res.status(providerStatus).json(providerResponse);
  });
  const agentServer = agent.listen(0, '127.0.0.1');
  await once(agentServer, 'listening');
  const token = 'test-only-credential';
  const options = { AGENT_SERVICE_URL: 'http://127.0.0.1:' + agentServer.address().port, AGENT_SERVICE_TOKEN: token };
  const original = Object.fromEntries(Object.keys(options).map(key => [key, process.env[key]]));
  Object.assign(process.env, options);
  t.after(async () => {
    await new Promise(resolve => agentServer.close(resolve));
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const service = {
    initialize: async () => {},
    async createPlan(spec, scope) {
      assert.equal(scope, sceneId);
      const id = '33333333-3333-4333-8333-33333333333' + saved.length;
      const plan = {
        id, version: 1, spec, status: 'validated',
        operator: { id: spec.kind, version: spec.operatorVersion },
        inputVersions: { target: { fileId: spec.target.fileId } },
      };
      saved.push(plan);
      return plan;
    },
    async getPlan(id) { return saved.find(item => item.id === id); },
  };
  const app = express();
  app.use(express.json());
  app.use(createScenePlannerRouter(catalog(), service));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  async function post(userPrompt, options = {}, scene = sceneId) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/scenes/' + scene + '/analysis/plans/natural-language', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userPrompt, fileIds: [], ...options }),
    });
    return { status: response.status, ...(await response.json()) };
  }

  const result = await post(prompt);
  assert.equal(result.status, 200);
  assert.equal(result.data.confirmationStatus, 'pending_confirmation');
  assert.equal(result.data.plan.spec.target.fileId, areaId);
  assert.equal(result.data.plan.spec.contiguity, 'rook');
  assert.equal(calls[0].authorization, 'Bearer ' + token);
  assert.deepEqual(calls[0].body.datasets[0], {
    ref: 'layer_1', name: '社区.geojson', geometryTypes: ['ST_Polygon'],
    fields: ['名称', 'pothole_requests', 'total_requests'], numericFields: ['pothole_requests', 'total_requests'],
  });
  const payload = JSON.stringify(calls[0].body);
  for (const privateText of [areaId, pointId, outsideId, sceneId, token, 'properties', 'featureCount']) {
    assert.ok(!payload.includes(privateText));
  }

  const followup = await post('对同一图层的 total_requests 用 Rook 共边邻接计算空间自相关，199 次置换',
    { contextPlanId: result.data.plan.id });
  assert.equal(followup.data.plan.spec.target.fileId, areaId);
  assert.equal(calls.at(-1).body.previousTarget, 'layer_1');
  assert.equal((await post('对同一图层的 total_requests 做 Moran/LISA', { contextPlanId: result.data.plan.id }, otherSceneId))
    .data.status, 'clarification');
  assert.equal((await post(prompt, { fileIds: [outsideId] })).errorCode, 'DATASET_NOT_FOUND');
  assert.equal((await post('用社区图层做 Moran/LISA')).data.status, 'clarification');
  assert.equal((await post('用社区图层的 total_requests 和 pothole_requests 做 Moran/LISA')).data.status, 'clarification');
  assert.equal((await post(prompt.replace('Rook 共边', 'Queen'))).data.status, 'clarification');
  assert.equal((await post(prompt.replace('199', '10000'))).data.status, 'clarification');
  assert.equal((await post('运行 SQL SELECT id FROM spatial_features')).data.status, 'unsupported');

  for (const [value, code] of [
    [{ ...moranDraft().spec, target: { fileId: 'layer_9', valueField: 'total_requests' } }, 'DATASET_NOT_FOUND'],
    [{ ...moranDraft().spec, target: { fileId: outsideId, valueField: 'total_requests' } }, 'DATASET_NOT_FOUND'],
    [{ ...moranDraft().spec, operatorVersion: 7 }, 'UNSUPPORTED_OPERATOR'],
    [{ ...moranDraft().spec, permutations: 10000 }, 'INVALID_SPEC'],
    [{ ...moranDraft().spec, contiguity: 'knn' }, 'INVALID_SPEC'],
    [{ ...moranDraft().spec, python: 'print(42)' }, 'INVALID_SPEC'],
  ]) {
    providerResponse = { status: 'ready', spec: value };
    assert.equal((await post(prompt)).errorCode, code);
  }
  providerResponse = { status: 'ready', spec: { ...moranDraft().spec, target: { fileId: 'layer_1', valueField: 'ghost' } } };
  assert.equal((await post(prompt)).data.status, 'clarification');
  providerResponse = 'invalid JSON';
  assert.equal((await post(prompt)).errorCode, 'PLANNER_INVALID_RESPONSE');
  providerStatus = 429;
  assert.equal((await post(prompt)).errorCode, 'PLANNER_RATE_LIMITED');
  providerStatus = 504;
  assert.equal((await post(prompt)).errorCode, 'PLANNER_TIMEOUT');
  assert.equal(saved.length, 2);

  const modelCalls = calls.length;
  const count = await post('统计每个社区内不同类型的设施数量，排除边界', { fileIds: [areaId, pointId] });
  assert.equal(count.data.source, 'rules');
  assert.equal(count.data.plan.spec.kind, 'spatial_pivot');
  assert.equal(calls.length, modelCalls);
});
