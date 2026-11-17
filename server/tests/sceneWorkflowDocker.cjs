const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

const phase06 = process.argv.includes('--phase06');
const expectedBase = phase06 ? 'http://127.0.0.1:8087' : 'http://127.0.0.1:8086';
const base = process.env.GEOCSV_WORKFLOW_TEST_URL ?? expectedBase;
const restart = process.argv.includes('--restart-agent');
const project = phase06 ? 'geocsv-phase06' : 'geocsv-04-acceptance';
const dbName = phase06 ? 'phase06_test' : 'workflow_acceptance';
const agent = project + '-agent-1';
const database = project + '-db-1';
const sceneId = '31521d56-f118-41d7-b08c-029cd4a26801';
const otherScene = '00000000-0000-4000-8000-000000000001';
const scope = '/scenes/' + sceneId + '/analysis';
const otherScope = '/scenes/' + otherScene + '/analysis';
const prompt = '2024 年 1 月，芝加哥坑洞投诉多的社区，是否也挨着投诉多的社区？如果有这种聚集，具体在哪里';
const clarificationPrompt = phase06
  ? require('../../agent_service/evals/chicago311.json').cases.find(item => item.id === 'metric-clarification').prompt
  : '芝加哥 2024 年 1 月的社区投诉有没有空间聚集？请先问我选哪个投诉指标，等我答复后再生成计划。';
const clarificationAnswer = '就分析坑洞投诉次数，比较相邻社区的坑洞投诉是否聚集。';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20000 }).trim();
const sql = ['psql', '-XAtq', '-U', 'geocsv', '-d', dbName, '-v', 'ON_ERROR_STOP=1'];
const query = statement => docker('exec', database, ...sql, '-c', statement);
const send = (path, action, fields, status) => api(path + '/events', { action, requestId: randomUUID(), ...fields }, status);
const api = async (path, body, status = 200) => {
  const response = await fetch(base + '/api' + path, {
    ...(body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result.data ?? result;
};

function verifyIsolatedDocker() {
  assert.equal(base, expectedBase, 'Use the independent acceptance instance for fault injection');
  const server = project + '-server-1';
  for (const container of [agent, database, server]) {
    assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "com.docker.compose.project"}}'), project);
  }
  assert.equal(docker('port', server, '8080/tcp'), expectedBase.slice('http://'.length));
  assert.equal(query('SELECT current_database()'), dbName);
}

async function waitFor(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(300);
  }
  assert.fail(label);
}

const restore = path => waitFor(() => api(path).catch(() => null), 'Agent did not restore the session');

async function restoreAfterRestart(path, before) {
  if (!restart) return;
  docker('restart', agent);
  assert.deepEqual(await restore(path), before);
}

async function interruptAfterRunCommit(path, approval, threadId) {
  const owner = 'workflow:' + sceneId + ':' + threadId;
  const lock = spawn('docker', ['exec', '-i', database, ...sql], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: lock.stdout });
  const locked = once(lines, 'line', { signal: AbortSignal.timeout(10000) });
  const exited = once(lock, 'close');
  lock.stdin.write("BEGIN; LOCK TABLE geocsv_analysis_plans IN ACCESS EXCLUSIVE MODE; SELECT 'locked';\n");
  let stopped = false;
  let killed = false;
  try {
    assert.deepEqual(await locked, ['locked']);
    const confirmation = api(path + '/events', approval, 503).then(() => null, error => error);
    await waitFor(() => query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' " +
      "AND query LIKE 'SELECT * FROM geocsv_analysis_plans WHERE id=%'") === '1', 'Submit did not reach Postgres');

    // Freeze the Agent after it started the callback, then let the real submission commit.
    docker('kill', '--signal', 'STOP', agent);
    stopped = true;
    await waitFor(() => /^State:\s+T/m.test(docker('exec', agent, 'cat', '/proc/1/status')), 'Agent did not stop');
    lock.stdin.end('COMMIT;\n');
    assert.deepEqual(await exited, [0, null]);
    const runId = await waitFor(() => query("SELECT id FROM geocsv_analysis_runs WHERE request_scope='" + owner + "'"),
      'Submit did not commit while the Agent was stopped');
    docker('kill', agent);
    killed = true;
    const failure = await confirmation;
    if (failure) throw failure;

    docker('start', agent);
    killed = false;
    stopped = false;
    const approved = await restore(path);
    assert.equal(approved.status, 'processing');
    assert.equal(approved.interactionId, approval.interactionId);
    assert.equal(approved.runId, null);
    const submitted = await send(path, 'resume', { interactionId: approval.interactionId });
    assert.equal(submitted.runId, runId);
    assert.equal(query("SELECT count(*) FROM geocsv_analysis_runs WHERE request_scope='" + owner + "'"), '1');
    return submitted;
  } finally {
    if (!lock.stdin.writableEnded) lock.stdin.end('ROLLBACK;\n');
    if (killed) docker('start', agent);
    else if (stopped) docker('kill', '--signal', 'CONT', agent);
    lines.close();
  }
}

async function verifyUpdatedInput(submittedPath, submitted) {
  const path = scope + '/sessions/' + randomUUID();
  const before = await send(path, 'start', { prompt });
  assert.equal(before.status, 'pending_confirmation');
  const oldPlan = before.proposal.plan;
  const fileId = oldPlan.spec.target.fileId;
  assert.match(fileId, /^[a-f0-9-]{36}$/);
  const update = delta => query("UPDATE spatial_features SET properties=jsonb_set(properties, '{pothole_requests}', " +
    "to_jsonb((properties->>'pothole_requests')::int + (" + delta + "))) " +
    "WHERE id=(SELECT min(id) FROM spatial_features WHERE file_id='" + fileId + "') RETURNING id");
  assert.match(update(1), /^\d+$/);
  try {
    const approval = { interactionId: before.interactionId };
    const conflict = await send(path, 'confirm', approval, 409);
    assert.match(conflict.message, /输入数据已改变/);
    assert.deepEqual(await api(path), before);
    assert.equal((await send(path, 'cancel', approval)).status, 'cancelled');
    await send(path, 'confirm', approval, 409);
    assert.equal(query("SELECT count(*) FROM geocsv_analysis_runs WHERE plan_id='" + oldPlan.id + "'"), '0');
    assert.equal((await api('/analysis/plans/' + oldPlan.id)).status, 'validated');

    const repeat = await send(submittedPath, 'confirm', { interactionId: submitted.interactionId });
    assert.equal(repeat.runId, submitted.runId);
    const next = await send(scope + '/sessions/' + randomUUID(), 'start', { prompt });
    assert.equal(next.status, 'pending_confirmation');
    assert.notEqual(next.proposal.plan.id, oldPlan.id);
    assert.notDeepEqual(next.proposal.plan.inputVersions, oldPlan.inputVersions);
    return { rejectedPlanId: oldPlan.id, replacementPlanId: next.proposal.plan.id };
  } finally {
    update(-1);
  }
}

async function main() {
  if (restart) verifyIsolatedDocker();
  const scenes = await api('/scenes');
  assert.ok(scenes.some(scene => scene.id === sceneId), 'Load the Chicago 311 acceptance data first');
  assert.ok(scenes.some(scene => scene.id === otherScene));
  const before = await api(scope + '/runs?limit=100');
  const threadId = randomUUID();
  const path = scope + '/sessions/' + threadId;
  const events = path + '/events';
  const clarification = await send(path, 'start', { prompt: clarificationPrompt });
  assert.equal(clarification.status, 'clarification', JSON.stringify(clarification));
  assert.ok(clarification.proposal.questions.length > 0);
  await restoreAfterRestart(path, clarification);
  const answer = { action: 'answer', requestId: randomUUID(), interactionId: clarification.interactionId, prompt: clarificationAnswer };
  const proposal = await api(events, answer);
  assert.equal(proposal.status, 'pending_confirmation', JSON.stringify(proposal));
  assert.notEqual(proposal.interactionId, clarification.interactionId);
  assert.ok(proposal.prompt.includes(clarificationAnswer));
  assert.deepEqual(await api(events, answer), proposal);
  assert.equal(proposal.proposal.plan.spec.target.valueField, 'pothole_requests');
  assert.equal(proposal.proposal.inputs.dataMonth, '2024-01');
  assert.equal(proposal.proposal.plan.spec.contiguity, 'queen');
  assert.equal(proposal.proposal.plan.spec.permutations, 199);
  assert.equal((await api(scope + '/runs?limit=100')).length, before.length);
  const otherPath = otherScope + '/sessions/' + threadId;
  await api(otherPath, undefined, 404);
  await send(otherPath, 'confirm', { interactionId: proposal.interactionId }, 404);
  const other = await send(otherPath, 'start', { prompt });
  assert.equal(other.status, 'clarification');
  assert.equal(other.sceneId, otherScene);
  await send(otherPath, 'cancel', { interactionId: proposal.interactionId }, 409);
  assert.equal((await send(otherPath, 'cancel', { interactionId: other.interactionId })).status, 'cancelled');
  await send(otherPath, 'answer', { interactionId: other.interactionId, prompt: clarificationAnswer }, 409);
  assert.deepEqual(await api(path), proposal);
  await send(path, 'confirm', { interactionId: clarification.interactionId }, 409);
  await restoreAfterRestart(path, proposal);

  const approval = { action: 'confirm', requestId: randomUUID(), interactionId: proposal.interactionId };
  const recovered = restart ? await interruptAfterRunCommit(path, approval, threadId) : null;
  const [submitted, retry] = await Promise.all([api(events, approval), api(events, approval)]);
  assert.equal(submitted.status, 'submitted');
  assert.equal(retry.runId, submitted.runId);
  if (recovered) assert.deepEqual(submitted, recovered);
  const secondClick = await api(events, { ...approval, requestId: randomUUID() });
  assert.equal(secondClick.runId, submitted.runId);
  await restoreAfterRestart(path, submitted);
  assert.deepEqual(await api(path), submitted);
  assert.deepEqual(await api(events, approval), submitted);
  await send(path, 'cancel', { interactionId: proposal.interactionId }, 409);
  const after = await api(scope + '/runs?limit=100');
  assert.equal(after.filter(item => item.planId === proposal.proposal.plan.id).length, 1);
  assert.ok(!(await api(otherScope + '/runs')).some(item => item.id === submitted.runId));
  let run = await api('/runs/' + submitted.runId);
  const deadline = Date.now() + 45000;
  while (['queued', 'running'].includes(run.status) && Date.now() < deadline) {
    await delay(1000);
    run = await api('/runs/' + run.id);
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  const artifact = await api('/artifacts/' + run.artifactId);
  const geometry = await api('/artifacts/' + run.artifactId + '/geojson');
  assert.equal(artifact.format, 'moran_lisa');
  assert.equal(artifact.totalRows, 77);
  assert.equal(geometry.features.length, 77);
  assert.ok(Math.abs(artifact.summary.globalI - 0.267211) < 0.00001);
  assert.equal(artifact.summary.pValue, 0.005);
  assert.ok(geometry.features.every(({ properties }) => typeof properties.label === 'string' && properties.label), 'Preserve region names');
  const highHigh = geometry.features.filter(({ properties }) =>
    properties.quadrant === 'HH' && properties.pValue !== null && properties.pValue <= 0.05)
    .map(({ properties }) => properties.label);
  assert.ok(highHigh.length > 0);
  const traceId = phase06 ? query("SELECT trace_id FROM geocsv_analysis_runs WHERE id='" + run.id + "'") : undefined;
  if (phase06) {
    assert.match(traceId, /^[a-f0-9]{32}$/);
    const entries = docker('logs', project + '-server-1').split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter(entry => entry.traceId === traceId);
    assert.ok(entries.some(entry => entry.event === 'workflow.run.accepted' && entry.runId === run.id));
    assert.ok(entries.some(entry => entry.event === 'artifact.postgis.committed' && entry.artifactId === artifact.id));
  }
  const updatedInput = restart ? await verifyUpdatedInput(path, submitted) : undefined;
  console.log(JSON.stringify({ traceId, threadId, planId: proposal.proposal.plan.id, runId: run.id, artifactId: artifact.id,
    globalI: artifact.summary.globalI, pValue: artifact.summary.pValue, regions: geometry.features.length, highHigh,
    recoveredAfterCommit: Boolean(recovered), updatedInput }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
