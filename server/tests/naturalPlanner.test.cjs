const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NaturalAnalysisPlanner } = require('../src/modules/analysisPlanner/service');
const { parseSpatialPivotSpec } = require('../src/modules/spatialPivot/plan');

const id = 'fbe596db-9e4a-4419-ad3c-b547ad443c15';
const datasets = [
  { fileId: 'districts', name: '示例街道.geojson', featureCount: 3, geometryTypes: ['ST_Polygon'], fields: ['名称', 'id'] },
  { fileId: 'pois', name: '示例设施.geojson', featureCount: 4, geometryTypes: ['ST_Point'], fields: ['类型', 'id'] },
];
const spec = () => ({ schemaVersion: 1, kind: 'spatial_pivot', operatorVersion: 1,
  target: { fileId: 'districts', labelField: '名称' }, join: { fileId: 'pois', categoryField: '类型' }, boundaryPolicy: 'exclude' });
const request = (userPrompt, rest = {}) => ({ userPrompt, fileIds: ['districts', 'pois'], ...rest });
const proposal = () => ({ status: 'ready', spec: spec(), view: { chartType: 'bar' }, unsupportedRequirements: [] });

const create = (overrides = {}) => new NaturalAnalysisPlanner({
  readDataset: async fileId => { const dataset = datasets.find(item => item.fileId === fileId); if (!dataset) throw new Error('unknown dataset'); return dataset; },
  validatePlan: async value => parseSpatialPivotSpec(value),
  getRun: async () => ({ id, status: 'succeeded', spec: spec(), artifactId: id }),
  ...overrides,
});

test('common requests reuse the verified operator and exactly match the form protocol without calling an LLM', async () => {
  let calls = 0;
  const planner = create({ complete: async () => { calls++; throw new Error('must not call model'); } });
  const result = await planner.plan(request('统计每个街道内不同类型的设施数量'));
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'rules');
  assert.deepEqual(result.spec, spec());
  assert.equal(calls, 0);
  assert.ok(result.assumptions.some(item => item.includes('默认')));
  const inclusive = await planner.plan(request('统计每个街道内不同类型的设施数量，纳入边界点，用饼图'));
  assert.equal(inclusive.status, 'ready');
  assert.equal(inclusive.spec.boundaryPolicy, 'include');
  assert.equal(inclusive.view.chartType, 'pie');
  const phrasedBoundary = await planner.plan(request('按照类型统计每个街道内设施数量，边界上的点也纳入统计'));
  assert.equal(phrasedBoundary.status, 'ready');
  assert.equal(phrasedBoundary.spec.boundaryPolicy, 'include');
  assert.equal((await planner.plan(request('统计设施数量'))).status, 'clarification');
});

test('ambiguous datasets and category fields ask questions instead of guessing', async () => {
  const planner = create({ readDataset: async fileId => fileId === 'second'
    ? { ...datasets[0], fileId: 'second', name: '另一街道.geojson' } : datasets.find(item => item.fileId === fileId) });
  const result = await planner.plan(request('统计每个街道内设施数量', { fileIds: ['districts', 'second', 'pois'] }));
  assert.equal(result.status, 'clarification');
  const missing = await create({ readDataset: async fileId => fileId === 'pois' ? { ...datasets[1], fields: ['id'] } : datasets[0] })
    .plan(request('按类型统计每个街道内设施数量'));
  assert.equal(missing.status, 'clarification');
  assert.equal((await create().plan(request('统计每个街道内设施数量，纳入边界并排除边界'))).status, 'clarification');
});

test('unsupported numerical, filtering, distance and distinct-category semantics never degrade to point count', async () => {
  let calls = 0;
  const planner = create({ complete: async () => { calls++; return proposal(); } });
  for (const prompt of ['统计街道周边500米设施数量', '统计街道内设施平均面积', '只统计街道内的学校数量',
    '统计街道内有多少类设施', '统计街道内设施数量前10名', '统计与街道相交的设施数量']) {
    assert.equal((await planner.plan(request(prompt))).status, 'unsupported', prompt);
  }
  assert.equal(calls, 0);
  const overlappingField = create({ readDataset: async fileId => fileId === 'pois'
    ? { ...datasets[1], fields: ['类型', '平均面积', '距离'] } : datasets[0], complete: async () => proposal() });
  assert.equal((await overlappingField.plan(request('统计每个街道内设施平均面积'))).status, 'unsupported');
  assert.equal((await overlappingField.plan(request('统计每个街道内设施距离'))).status, 'unsupported');
});

test('view-only follow-ups read server context without querying datasets, planning code or creating a run', async () => {
  const planner = create({ readDataset: async () => { throw new Error('view must not reread source data'); }, complete: async () => { throw new Error('view must not call model'); } });
  const result = await planner.plan(request('请换成饼图', { fileIds: [], contextRunId: id }));
  assert.equal(result.status, 'view_only');
  assert.equal(result.runId, id);
  assert.equal(result.artifactId, id);
  assert.equal(result.view.chartType, 'pie');
  for (const prompt of ['把上次结果换成饼图', '用折线图展示上一条分析', '请把历史分析结果改成柱状图']) {
    assert.equal((await planner.plan(request(prompt, { fileIds: [], contextRunId: id }))).status, 'view_only', prompt);
  }
  assert.equal((await create().plan(request('给这个报告弄个饼图', { contextRunId: id }))).status, 'clarification');
  assert.equal((await create({ getRun: async () => null }).plan(request('换成饼图', { contextRunId: id }))).status, 'clarification');
  assert.equal((await create().plan(request('换成饼图'))).status, 'clarification');
  assert.equal((await create().plan(request('柱状图和饼图'))).status, 'clarification');
});

test('explicit target labels are preserved instead of replaced with a default display field', async () => {
  const planner = create({ readDataset: async fileId => fileId === 'districts'
    ? { ...datasets[0], fields: [...datasets[0].fields, '代码'] } : datasets[1] });
  const result = await planner.plan(request('统计每个街道内设施数量，结果以代码标识'));
  assert.equal(result.status, 'ready');
  assert.equal(result.spec.target.labelField, '代码');
  assert.equal((await planner.plan(request('统计每个街道内设施数量，结果以不存在字段标识'))).status, 'clarification');
});

test('model proposals can only reference selected datasets, real fields and the verified protocol', async () => {
  const prompt = '请核算每个行政区所辖的服务设施总量';
  const run = async output => create({ complete: async () => output }).plan(request(prompt));
  const valid = await run(proposal());
  assert.equal(valid.status, 'ready');
  assert.equal(valid.source, 'llm');
  assert.deepEqual(valid.spec, spec());
  const hidden = proposal(); hidden.spec.join.fileId = 'hidden';
  assert.equal((await run(hidden)).status, 'clarification');
  const invented = proposal(); invented.spec.join.categoryField = 'imaginary';
  assert.equal((await run(invented)).status, 'clarification');
  const python = { ...proposal(), pythonCode: 'raise RuntimeError()' };
  assert.equal((await run(python)).status, 'unsupported');
  const conditions = { ...proposal(), unsupportedRequirements: ['filter by category'] };
  assert.equal((await run(conditions)).status, 'unsupported');
  const unknown = proposal(); unknown.spec.operatorVersion = 100;
  assert.equal((await run(unknown)).status, 'unsupported');
  const arrayChart = proposal(); arrayChart.view.chartType = ['bar'];
  assert.equal((await run(arrayChart)).status, 'clarification');
  const wrongBoundary = proposal(); wrongBoundary.spec.boundaryPolicy = 'include';
  assert.equal((await run(wrongBoundary)).status, 'clarification');
  assert.equal((await run({ status: 'ready' })).status, 'unsupported');
  assert.equal((await run({ status: 'clarification', questions: ['请选择具体图层'] })).status, 'clarification');
});

test('input limits reject payload-based execution/context injection and model errors do not trigger an experiment', async () => {
  const planner = create();
  await assert.rejects(planner.plan(request('', {})));
  await assert.rejects(planner.plan(request('x'.repeat(4001))));
  await assert.rejects(planner.plan(request('统计数量', { pythonCode: 'unsafe' })));
  await assert.rejects(planner.plan(request('统计数量', { contextRunId: 'invalid' })));
  const result = await create({ complete: async () => { throw new SyntaxError('bad JSON'); } }).plan(request('请核算每个行政区所辖的服务设施总量'));
  assert.equal(result.status, 'clarification');
  assert.ok(result.questions[0].includes('未提交任何计算'));
});
