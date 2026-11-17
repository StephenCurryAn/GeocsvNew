const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const { createScenePlannerRouter } = require('../src/modules/analysisPlanner/sceneRouter');
const { listRegisteredOperators } = require('../src/modules/operators/registry');
const { parseMoranSpec } = require('../src/modules/operators/moranLisa');
const { readOperatorParameters } = require('../src/modules/operators/parameters');

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
const moranDraft = (parameters = { contiguity: 'rook', permutations: 199 }, ref = 'layer_1', field = 'total_requests') => ({
  status: 'ready',
  operator: { id: 'spatial_autocorrelation', version: 2 },
  inputs: { target: { ref, fields: { valueField: field } } },
  parameters,
});
const prompt = '用社区图层的 total_requests 做 Moran/LISA，Rook 共边邻接，199 次置换';

function catalog() {
  return {
    async query(sql, [id, ids]) {
      let rows;
      const file = files.get(id);
      if (sql.includes('FROM scenes')) rows = [sceneId, otherSceneId].includes(id) ? [{}] : [];
      else if (sql.includes('geocsv_analysis_dataset_periods')) rows = id.includes(areaId)
        ? [{ file_id: areaId, month: '2024-01' }] : [];
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
  const third = {
    descriptor: {
      id: 'test_point_sample', version: 3, name: '点抽样',
      description: '测试用点图层抽样', aliases: ['抽取样本'],
      inputs: { source: { geometryTypes: ['ST_Point'] } }, parameterSchema: '#/test/PointSampleSpec',
      planningParameters: { type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: '样本量' } } },
    },
    planDraft({ inputs, parameters }) {
      const { dataset } = inputs.source;
      const { limit } = readOperatorParameters(this.descriptor.planningParameters, parameters);
      return { status: 'ready', source: 'llm', message: this.descriptor.name, inputs: { targetName: dataset.name },
        spec: { schemaVersion: 1, kind: this.descriptor.id, operatorVersion: 3, target: { fileId: dataset.fileId }, limit } };
    },
  };
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
  app.use(createScenePlannerRouter(catalog(), service, [...listRegisteredOperators(), third]));
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
  assert.equal(result.data.plan.spec.seed, 42);
  assert.equal(calls[0].authorization, 'Bearer ' + token);
  assert.deepEqual(calls[0].body.datasets[0], {
    ref: 'layer_1', name: '社区.geojson', geometryTypes: ['ST_Polygon'],
    fields: ['名称', 'pothole_requests', 'total_requests'], numericFields: ['pothole_requests', 'total_requests'],
    fieldLabels: { pothole_requests: '坑洞投诉次数', total_requests: '服务请求总量' },
  });
  assert.equal(calls[0].body.datasets.length, 1);
  assert.deepEqual(calls[0].body.operators.map(operator => operator.id), ['spatial_autocorrelation']);
  assert.deepEqual(calls[0].body.operators[0].eligibleRefs, { target: ['layer_1'] });
  assert.equal(calls[0].body.operators[0].planningParameters.properties.seed.default, result.data.plan.spec.seed);
  const payload = JSON.stringify(calls[0].body);
  for (const privateText of [areaId, pointId, outsideId, sceneId, token, 'featureCount']) {
    assert.ok(!payload.includes(privateText));
  }

  const followup = await post('对同一图层的 total_requests 用 Rook 共边邻接计算空间自相关，199 次置换',
    { contextPlanId: result.data.plan.id });
  assert.equal(followup.data.plan.spec.target.fileId, areaId);
  assert.equal(calls.at(-1).body.history.inputs.target, 'layer_1');
  assert.equal((await post('对同一图层的 total_requests 做 Moran/LISA', { contextPlanId: result.data.plan.id }, otherSceneId))
    .data.status, 'clarification');
  assert.equal((await post(prompt, { fileIds: [outsideId] })).errorCode, 'DATASET_NOT_FOUND');
  const beforeMissingTarget = calls.length;
  assert.equal((await post(prompt, { fileIds: [pointId] })).data.status, 'clarification');
  assert.equal(calls.length, beforeMissingTarget);
  assert.equal((await post(prompt + '，指定 spatial_autocorrelation@7')).data.status, 'unsupported');
  assert.equal(calls.length, beforeMissingTarget);
  assert.equal((await post('用社区图层做 Moran/LISA')).data.status, 'clarification');
  assert.equal((await post('用社区图层的 total_requests 和 pothole_requests 做 Moran/LISA')).data.status, 'clarification');
  assert.equal((await post(prompt.replace('Rook 共边', 'Queen'))).data.status, 'clarification');
  assert.equal((await post(prompt.replace('199', '10000'))).data.status, 'clarification');
  assert.equal((await post(prompt.replace('199', '10,000'))).data.status, 'clarification');
  assert.equal((await post(prompt + '，99 次置换')).data.status, 'clarification');
  assert.equal((await post(prompt + '，同时采用 Queen')).data.status, 'clarification');
  assert.equal((await post('运行 SQL SELECT id FROM spatial_features')).data.status, 'unsupported');

  const conversational = '2024 年 1 月，芝加哥坑洞投诉多的社区，是否也挨着投诉多的社区？如果有这种聚集，具体在哪里？';
  providerResponse = moranDraft({}, 'layer_1', 'pothole_requests');
  const natural = await post(conversational);
  assert.equal(natural.data.confirmationStatus, 'pending_confirmation');
  assert.deepEqual(natural.data.inputs, { targetName: '社区.geojson', metricLabel: '坑洞投诉次数', dataMonth: '2024-01' });
  assert.deepEqual(natural.data.spec.target, { fileId: areaId, valueField: 'pothole_requests', labelField: '名称' });
  assert.equal(natural.data.spec.contiguity, 'queen');
  assert.equal((await post(conversational.replace('1 月', '2 月'))).data.status, 'clarification');
  providerResponse = moranDraft({}, 'layer_1', 'total_requests');
  assert.equal((await post(conversational)).data.status, 'clarification');

  for (const [value, code] of [
    [moranDraft(undefined, 'layer_9'), 'DATASET_NOT_FOUND'],
    [moranDraft(undefined, outsideId), 'DATASET_NOT_FOUND'],
    [{ ...moranDraft(), operator: { id: 'spatial_autocorrelation', version: 7 } }, 'UNSUPPORTED_OPERATOR'],
    [{ ...moranDraft(), operator: { id: third.descriptor.id, version: 3 } }, 'UNSUPPORTED_OPERATOR'],
    [moranDraft({ permutations: 10000 }), 'INVALID_SPEC'],
    [moranDraft({ permutations: '199' }), 'INVALID_SPEC'],
    [moranDraft({ contiguity: 'knn' }), 'INVALID_SPEC'],
    [moranDraft({ python: 'print(42)' }), 'INVALID_SPEC'],
  ]) {
    providerResponse = value;
    assert.equal((await post(prompt)).errorCode, code);
  }
  providerResponse = moranDraft(undefined, undefined, 'ghost');
  assert.equal((await post(prompt)).data.status, 'clarification');
  providerResponse = 'invalid JSON';
  assert.equal((await post(prompt)).errorCode, 'PLANNER_INVALID_RESPONSE');
  providerStatus = 429;
  assert.equal((await post(prompt)).errorCode, 'PLANNER_RATE_LIMITED');
  providerStatus = 504;
  assert.equal((await post(prompt)).errorCode, 'PLANNER_TIMEOUT');
  assert.equal(saved.length, 3);

  providerStatus = 200;
  providerResponse = moranDraft({ contiguity: 'rook' });
  const withoutPermutation = prompt.split('，199')[0];
  const defaulted = await post(withoutPermutation);
  assert.deepEqual(defaulted.data.spec, parseMoranSpec({
    schemaVersion: 1, kind: 'spatial_autocorrelation', operatorVersion: 2,
    target: { fileId: areaId, valueField: 'total_requests', labelField: '名称' }, contiguity: 'rook',
  }));
  assert.equal(defaulted.data.spec.permutations, 199);
  providerResponse = moranDraft({ contiguity: 'rook', permutations: 123, seed: 99 });
  const guessing = await post(withoutPermutation);
  assert.deepEqual(guessing.data.spec, defaulted.data.spec);
  assert.equal((await post(withoutPermutation + '，置换次数用两百次')).data.status, 'clarification');
  providerResponse = moranDraft({ contiguity: 'rook', permutations: 0, seed: 0 });
  const zero = await post(withoutPermutation + '，0 次置换，种子 0');
  assert.equal(zero.data.spec.permutations, 0);
  assert.equal(zero.data.spec.seed, 0);
  const englishZero = await post('Use Rook Moran/LISA on total_requests from 社区.geojson with 0 permutations, seed: 0');
  assert.equal(englishZero.data.spec.permutations, 0);
  assert.equal(englishZero.data.spec.seed, 0);
  providerResponse = moranDraft({ contiguity: 'rook' });
  assert.equal((await post(withoutPermutation + '，0 次置换')).data.status, 'clarification');

  providerResponse = {
    status: 'ready', operator: { id: third.descriptor.id, version: 3 },
    inputs: { source: { ref: 'layer_1', fields: {} } }, parameters: {},
  };
  const sampled = await post('在设施图层抽取样本');
  assert.equal(sampled.data.plan.spec.kind, third.descriptor.id);
  assert.equal(sampled.data.plan.spec.target.fileId, pointId);
  assert.equal(sampled.data.plan.spec.limit, 3);
  assert.deepEqual(calls.at(-1).body.datasets.map(item => item.name), ['设施.geojson']);
  assert.deepEqual(calls.at(-1).body.operators.map(item => item.id), [third.descriptor.id]);

  const modelCalls = calls.length;
  const count = await post('统计每个社区内不同类型的设施数量，排除边界', { fileIds: [areaId, pointId] });
  assert.equal(count.data.source, 'rules');
  assert.equal(count.data.plan.spec.kind, 'spatial_pivot');
  assert.equal(calls.length, modelCalls);
});
