const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const base = process.env.GEOCSV_WORKFLOW_TEST_URL ?? 'http://127.0.0.1:8085';
const sceneId = '31521d56-f118-41d7-b08c-029cd4a26801';
const otherScene = '00000000-0000-4000-8000-000000000001';
const prompt = '2024 年 1 月，芝加哥坑洞投诉多的社区，是否也挨着投诉多的社区？如果有这种聚集，具体在哪里';
const api = async (path, body, status = 200) => {
  const response = await fetch(base + '/api' + path, {
    ...(body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result.data ?? result;
};

async function restoreAfterRestart(path, before) {
  if (!process.argv.includes('--restart-agent')) return;
  assert.equal(new URL(base).origin, 'http://127.0.0.1:8085', 'Restart only the isolated local instance');
  const name = 'geocsv-workflow-agent-1';
  const project = execFileSync('docker', ['inspect', name, '--format',
    '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: 'utf8' }).trim();
  assert.equal(project, 'geocsv-workflow');
  execFileSync('docker', ['restart', name]);
  const deadline = Date.now() + 25000;
  let restored;
  while (!restored && Date.now() < deadline) {
    try { restored = await api(path); } catch { await delay(1000); }
  }
  assert.ok(restored);
  assert.equal(restored.status, 'pending_confirmation');
  assert.equal(restored.interactionId, before.interactionId);
  assert.equal(restored.proposal.plan.id, before.proposal.plan.id);
}

async function main() {
  const scenes = await api('/scenes');
  assert.ok(scenes.some(scene => scene.id === sceneId), 'Load the Chicago 311 acceptance data first');
  const scope = '/scenes/' + sceneId + '/analysis';
  const before = await api(scope + '/runs?limit=100');
  const threadId = randomUUID();
  const path = scope + '/sessions/' + threadId;
  const events = path + '/events';
  const proposal = await api(events, { action: 'start', requestId: randomUUID(), prompt });
  assert.equal(proposal.status, 'pending_confirmation', JSON.stringify(proposal));
  assert.equal(proposal.proposal.plan.spec.target.valueField, 'pothole_requests');
  assert.equal(proposal.proposal.inputs.dataMonth, '2024-01');
  assert.equal(proposal.proposal.plan.spec.contiguity, 'queen');
  assert.equal(proposal.proposal.plan.spec.permutations, 199);
  assert.equal((await api(scope + '/runs?limit=100')).length, before.length);
  await api('/scenes/' + otherScene + '/analysis/sessions/' + threadId, undefined, 404);
  await api(events, { action: 'confirm', requestId: randomUUID(), interactionId: randomUUID() }, 409);
  await restoreAfterRestart(path, proposal);
  const approval = { action: 'confirm', requestId: randomUUID(), interactionId: proposal.interactionId };
  const [submitted, retry] = await Promise.all([api(events, approval), api(events, approval)]);
  assert.equal(submitted.status, 'submitted');
  assert.equal(retry.runId, submitted.runId);
  const secondClick = await api(events, { ...approval, requestId: randomUUID() });
  assert.equal(secondClick.runId, submitted.runId);
  assert.equal((await api(path)).runId, submitted.runId);
  const after = await api(scope + '/runs?limit=100');
  assert.equal(after.filter(item => item.planId === proposal.proposal.plan.id).length, 1);
  assert.ok(!(await api('/scenes/' + otherScene + '/analysis/runs')).some(item => item.id === submitted.runId));
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
  console.log(JSON.stringify({ threadId, planId: proposal.proposal.plan.id, runId: run.id, artifactId: artifact.id,
    globalI: artifact.summary.globalI, pValue: artifact.summary.pValue, regions: geometry.features.length, highHigh }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
