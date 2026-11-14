import test from 'node:test';
import assert from 'node:assert/strict';
import { RUN_HISTORY_LIMIT, useRunHistoryStore } from '../src/stores/useRunHistoryStore.ts';

const makeRun = (id, status = 'queued', createdAt = '2026-01-01T00:00:00.000Z') => ({
  id,
  status,
  spec: {
    schemaVersion: 1,
    kind: 'spatial_pivot',
    operatorVersion: 1,
    target: { fileId: 'districts', labelField: null },
    join: { fileId: 'pois', categoryField: null },
    boundaryPolicy: 'exclude',
  },
  artifactId: status === 'succeeded' ? `artifact-${id}` : null,
  error: null,
  createdAt,
  completedAt: status === 'succeeded' ? createdAt : null,
});

const resetStore = () => useRunHistoryStore.getState().setRunHistory([]);

test('updates are visible to independent subscribers and preserve the updater interface', () => {
  resetStore();
  let firstUpdates = 0;
  let secondUpdates = 0;
  const stopFirst = useRunHistoryStore.subscribe(() => { firstUpdates += 1; });
  const stopSecond = useRunHistoryStore.subscribe(() => { secondUpdates += 1; });

  useRunHistoryStore.getState().setRunHistory(current => [...current, makeRun('shared')]);

  assert.deepEqual(useRunHistoryStore.getState().runHistory.map(run => run.id), ['shared']);
  assert.equal(firstUpdates, 1);
  assert.equal(secondUpdates, 1);
  stopFirst();
  stopSecond();
});

test('late queued or running snapshots cannot downgrade a terminal run', () => {
  resetStore();
  const succeeded = makeRun('terminal', 'succeeded', '2026-02-01T00:00:00.000Z');
  useRunHistoryStore.getState().setRunHistory([succeeded]);
  useRunHistoryStore.getState().setRunHistory([makeRun('terminal', 'running', succeeded.createdAt)]);
  useRunHistoryStore.getState().setRunHistory([makeRun('terminal', 'queued', succeeded.createdAt)]);

  const [stored] = useRunHistoryStore.getState().runHistory;
  assert.equal(stored.status, 'succeeded');
  assert.equal(stored.artifactId, 'artifact-terminal');
});

test('history is sorted newest-first and capped at 20 entries', () => {
  resetStore();
  const runs = Array.from({ length: RUN_HISTORY_LIMIT + 5 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return makeRun(`run-${day}`, 'queued', `2026-03-${day}T00:00:00.000Z`);
  });
  useRunHistoryStore.getState().setRunHistory(runs);

  const history = useRunHistoryStore.getState().runHistory;
  assert.equal(history.length, RUN_HISTORY_LIMIT);
  assert.equal(history[0].id, 'run-25');
  assert.equal(history.at(-1).id, 'run-06');
});
