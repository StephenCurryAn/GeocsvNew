const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const suite = require('./chicago311.json');

const live = process.argv.includes('--live');
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(name + '='))?.split('=')[1] ?? fallback;
const rounds = Number(option('--rounds', '1'));
const maxCalls = Number(option('--max-calls', '24'));
const project = 'geocsv-phase06';
const containers = ['server', 'agent', 'db'].map(service => project + '-' + service + '-1');
const [server, agent, db] = containers;
const base = 'http://127.0.0.1:8087';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).trim();
const query = sql => docker('exec', db, 'psql', '-XAtq', '-U', 'geocsv', '-d', 'phase06_test', '-v', 'ON_ERROR_STOP=1', '-c', sql);
const scenePath = scene => '/scenes/' + scene + '/analysis';
const validId = id => {
  assert.match(id, /^[a-f\d-]{36}$/i);
  return id;
};

function verifyInstance() {
  for (const container of containers) {
    assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "com.docker.compose.project"}}'), project);
  }
  assert.equal(docker('port', server, '8080/tcp'), '127.0.0.1:8087');
  assert.equal(query('SELECT current_database()'), 'phase06_test');
  assert.equal(query(`SELECT concat(p.month, ':', count(*)) FROM geocsv_analysis_dataset_periods p
    JOIN spatial_features f ON f.file_id=p.file_id JOIN file_nodes n ON n.id=p.file_id
    WHERE p.file_id='${suite.layerId}' AND n.scene_id='${suite.sceneId}'
    AND f.properties ?& ARRAY['pothole_requests','total_requests'] GROUP BY p.month`), suite.month + ':' + suite.count);
  const command = docker('inspect', agent, '--format', '{{json .Config.Cmd}}');
  assert.equal(command.includes('evals.fixture_app:app'), !live, 'Agent mode differs from the requested evaluation mode');
  if (live) {
    // Validate the model configuration inside the container without exposing credentials.
    docker('exec', agent, 'python', '-c', "import os; from urllib.parse import urlsplit; " +
      "assert os.getenv('ALIYUN_API_KEY') and urlsplit(os.getenv('LLM_BASE_URL', '')).hostname == 'api.deepseek.com'");
  }
}

class CheckFailure extends Error {
  constructor(category, actual) {
    super(category);
    this.actual = actual;
  }
}

function check(condition, category, actual) {
  if (!condition) throw new CheckFailure(category, actual);
}

async function api(path, body) {
  const response = await fetch(base + '/api' + path, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(55000),
  }).catch(() => { throw new CheckFailure('api_transport'); });
  const result = await response.json().catch(() => { throw new CheckFailure('api_response_format', { httpStatus: response.status }); });
  return { httpStatus: response.status, traceId: response.headers.get('x-geocsv-trace-id'),
    errorCode: result.errorCode, data: result.data ?? (result.type === 'FeatureCollection' ? result : undefined) };
}

const send = (path, action, fields) => api(path + '/events', { action, requestId: randomUUID(), ...fields });
const scopedRuns = thread => Number(query(`SELECT count(*) FROM geocsv_analysis_runs
  WHERE request_scope='workflow:${suite.sceneId}:${thread}'`));

function assertExpected(response, expected) {
  const { httpStatus, errorCode, data } = response;
  check(httpStatus === (expected.httpStatus ?? 200), 'http_status', { httpStatus, errorCode });
  if (expected.errorCode) {
    check(errorCode === expected.errorCode, 'error_code', { errorCode });
    return { httpStatus, errorCode };
  }
  check(data?.status === expected.status, 'workflow_status', { status: data?.status });
  if (expected.questionPattern) {
    check(data.proposal?.questions?.some(question => new RegExp(expected.questionPattern, 'i').test(question)),
      'clarification_topic');
  }
  if (!expected.field) return { status: data.status };
  const plan = data.proposal?.plan;
  check(plan?.status === 'validated' && plan.version === 1 && plan.operator.id === 'spatial_autocorrelation' &&
    plan.operator.version === 2, 'plan_version');
  const spec = plan.spec;
  const actual = {
    field: spec.target.valueField, contiguity: spec.contiguity, permutations: spec.permutations, seed: spec.seed,
    month: data.proposal.inputs?.dataMonth, count: plan.inputVersions?.target?.count, layerId: spec.target.fileId,
  };
  check(actual.field === expected.field && actual.contiguity === expected.contiguity &&
    actual.permutations === expected.permutations && actual.seed === expected.seed &&
    actual.month === suite.month && actual.count === suite.count && actual.layerId === suite.layerId,
  'plan_parameters', actual);
  check(query(`SELECT confirmed_at IS NULL FROM geocsv_analysis_plans WHERE id='${validId(plan.id)}'`) === 't',
    'plan_not_pending');
  return { status: data.status, planId: plan.id, planVersion: plan.version, ...actual };
}

async function execute(path, response, result, expected) {
  const confirmation = { interactionId: response.data.interactionId };
  const approval = { action: 'confirm', requestId: randomUUID(), ...confirmation };
  const approvals = await Promise.all([api(path + '/events', approval), api(path + '/events', approval)]);
  approvals.push(await send(path, 'confirm', confirmation));
  const runId = approvals[0].data?.runId;
  check(runId && approvals.every(item => item.httpStatus === 200 && item.data?.status === 'submitted' &&
    item.data.runId === runId && item.traceId === result.traceId), 'confirmation');
  result.runId = validId(runId);
  const deadline = Date.now() + 40000;
  let run;
  do {
    run = (await api('/runs/' + runId)).data;
    if (!['queued', 'running'].includes(run?.status)) break;
    await delay(300);
  } while (Date.now() < deadline);
  check(run?.status === 'succeeded', 'execution', { status: run?.status, errorCode: run?.errorCode });
  result.artifactId = validId(run.artifactId);
  const artifact = (await api('/artifacts/' + run.artifactId)).data;
  const geometry = (await api('/artifacts/' + run.artifactId + '/geojson')).data;
  check(artifact?.format === 'moran_lisa' && artifact.totalRows === suite.count &&
    Math.abs(artifact.summary.globalI - expected.globalI) < 1e-9 && artifact.summary.pValue === expected.pValue, 'artifact');
  const highHigh = new Set(geometry?.features?.filter(({ properties }) =>
    properties.quadrant === 'HH' && properties.pValue !== null && properties.pValue <= 0.05)
    .map(({ properties }) => properties.label?.toUpperCase()));
  check(geometry?.features?.length === suite.count && expected.highHigh.every(label => highHigh.has(label.toUpperCase())),
    'local_clusters');
  check(query(`SELECT trace_id FROM geocsv_analysis_runs WHERE id='${runId}'`) === result.traceId, 'persisted_trace');
  result.statistic = { globalI: artifact.summary.globalI, pValue: artifact.summary.pValue, rows: artifact.totalRows };
}

async function runCase(item, round) {
  const result = { id: item.id, set: item.set, round, traceId: null, passed: false };
  const started = performance.now();
  const thread = randomUUID();
  const path = scenePath(suite.sceneId) + '/sessions/' + thread;
  const allowExecution = Boolean(item.execute && round === 1);
  let expectedRuns = 0;
  try {
    const before = Number(query('SELECT count(*) FROM geocsv_analysis_plans'));
    const beforeRuns = Number(query('SELECT count(*) FROM geocsv_analysis_runs'));
    const directScene = item.foreignSelection ? suite.otherSceneId : suite.sceneId;
    const direct = item.expected.httpStatus !== undefined;
    let response = direct ? await api(scenePath(directScene) + '/plans/natural-language', {
      userPrompt: item.prompt, fileIds: item.foreignSelection ? [suite.layerId] : [],
    }) : await send(path, 'start', { prompt: item.prompt });
    result.traceId = response.traceId;
    check(/^[a-f0-9]{32}$/.test(result.traceId), 'http_trace');
    check(scopedRuns(thread) === 0, 'execution_before_confirmation');
    result.actual = assertExpected(response, item.expected);
    if (item.answer) {
      const previous = response.data.interactionId;
      response = await send(path, 'answer', { interactionId: previous, prompt: item.answer.prompt });
      check(response.traceId === result.traceId && previous !== response.data?.interactionId, 'clarification_resume');
      check(scopedRuns(thread) === 0, 'execution_before_confirmation');
      result.afterAnswer = assertExpected(response, item.answer.expected);
    }
    const planId = result.afterAnswer?.planId ?? result.actual.planId;
    check(Number(query('SELECT count(*) FROM geocsv_analysis_plans')) === before + Number(Boolean(planId)), 'unexpected_plan');
    check(Number(query('SELECT count(*) FROM geocsv_analysis_runs')) === beforeRuns, 'execution_before_confirmation');
    if (allowExecution) {
      expectedRuns = 1;
      await execute(path, response, result, item.execute);
    }
    result.passed = true;
  } catch (error) {
    result.failure = error instanceof CheckFailure ? error.message : 'harness_error';
    if (error instanceof CheckFailure) result.observed = error.actual;
  }
  if (scopedRuns(thread) !== expectedRuns) {
    result.passed = false;
    result.failure ??= 'run_count';
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

function recentTraces(since) {
  return [server, agent].flatMap(container => {
    // Docker routes Uvicorn records through stderr and Express records through stdout.
    const { status, stdout, stderr } = spawnSync(
      'docker', ['logs', '--since', since, container], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(status, 0, 'Cannot read trace records');
    return (stdout + '\n' + stderr).split(/\r?\n/).flatMap(line => {
      try {
        const entry = JSON.parse(line.slice(line.indexOf('{')));
        return entry.traceId && entry.event ? [entry] : [];
      } catch { return []; }
    });
  }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

async function main() {
  verifyInstance();
  assert.equal((await api('/health')).httpStatus, 200, 'The evaluation web endpoint is unavailable');
  const cases = suite.cases.filter(item => !live || item.set !== 'safety');
  const expectedCalls = cases.reduce((total, item) => total + (item.fixture ? 1 : 0) + (item.answer ? 1 : 0), 0);
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && Number.isSafeInteger(maxCalls) &&
    rounds * expectedCalls <= maxCalls, 'Evaluation exceeds the configured model call limit');
  const started = new Date().toISOString();
  const results = [];
  for (let round = 1; round <= rounds; round++) {
    for (const item of cases) results.push(await runCase(item, round));
  }
  const records = recentTraces(started);
  for (const result of results) {
    const item = cases.find(candidate => candidate.id === result.id);
    const entries = records.filter(record => record.traceId === result.traceId);
    result.modelCalls = entries.filter(record => record.event === 'langchain.model');
    const fail = category => {
      result.passed = false;
      result.failure ??= category;
    };
    if (result.passed && result.modelCalls.length !== Number(Boolean(item.fixture)) + Number(Boolean(item.answer))) fail('model_call_count');
    if (live && result.modelCalls.some(call => call.outputMode !== 'deepseek_strict_tool')) fail('model_mode');
    if (live && result.modelCalls.every(call => call.status !== 'failed')) {
      const statuses = [item.expected.status, ...(item.answer ? [item.answer.expected.status] : [])]
        .map(status => status === 'pending_confirmation' ? 'ready' : status);
      result.modelStatusMatches = statuses.every((status, index) => result.modelCalls[index]?.status === status);
    }
    if (item.expected.traceError && !entries.some(entry => entry.errorCategory === item.expected.traceError)) fail('trace_error_category');
    if (result.artifactId) {
      result.trace = entries;
      for (const event of ['workflow.http.event', 'langgraph.event.completed', 'langchain.model', 'plan.persisted',
        'workflow.run.accepted', 'python.worker.result', 'execution.python.completed', 'artifact.postgis.committed']) {
        if (!entries.some(entry => entry.event === event)) fail('missing_trace_event');
      }
    }
    if (!result.passed) {
      result.failure = result.modelCalls.find(call => call.errorCategory)?.errorCategory ?? result.failure;
    }
    if (item.expected.traceError) result.diagnostics = entries.filter(entry => entry.errorCategory);
  }
  const usage = results.flatMap(result => result.modelCalls);
  const report = {
    mode: live ? 'deepseek' : 'deterministic', suiteVersion: suite.version, started, rounds,
    passed: results.filter(result => result.passed).length, total: results.length, failures: {},
    durationMs: Date.now() - Date.parse(started), modelCalls: usage.length,
    callsWithUsage: usage.filter(call => Number.isInteger(call.totalTokens)).length,
    inputTokens: usage.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
    cachedInputTokens: usage.reduce((sum, call) => sum + (call.cachedInputTokens ?? 0), 0),
    ...(live ? { modelStatusMatches: results.filter(result => result.modelStatusMatches).length } : {}),
    byRound: Array.from({ length: rounds }, (_, index) => {
      const group = results.filter(result => result.round === index + 1);
      return { round: index + 1, passed: group.filter(result => result.passed).length, total: group.length };
    }),
    results,
  };
  for (const result of results.filter(result => !result.passed)) {
    report.failures[result.failure] = (report.failures[result.failure] ?? 0) + 1;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 1;
}

main().catch(error => {
  console.error('Chicago 311 evaluation could not run:',
    error instanceof assert.AssertionError || error instanceof CheckFailure ? error.message : error.name);
  process.exitCode = 1;
});
