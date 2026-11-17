import { create } from 'zustand';
import type { Run } from '../services/analysisService';

export const RUN_HISTORY_LIMIT = 20;

export type RunHistoryUpdate = Run[] | ((current: Run[]) => Run[]);

const isTerminal = (status: Run['status']): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';

const statusRank = (status: Run['status']): number => {
  if (status === 'queued') return 0;
  if (status === 'running') return 1;
  return 2;
};

const newestSnapshot = (current: Run, incoming: Run): Run => {
  if (isTerminal(current.status) && !isTerminal(incoming.status)) return current;
  if (isTerminal(current.status) && isTerminal(incoming.status) && current.status !== incoming.status) return current;
  return statusRank(current.status) > statusRank(incoming.status) ? current : incoming;
};

export const mergeRunHistory = (current: Run[], incoming: Run[]): Run[] => {
  const byId = new Map(current.map(run => [run.id, run]));
  for (const candidate of incoming) {
    const previous = byId.get(candidate.id);
    byId.set(candidate.id, previous ? newestSnapshot(previous, candidate) : candidate);
  }
  return [...byId.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, RUN_HISTORY_LIMIT);
};

interface RunHistoryState {
  runHistory: Run[];
  setRunHistory: (update: RunHistoryUpdate) => void;
}

export const useRunHistoryStore = create<RunHistoryState>()(set => ({
  runHistory: [],
  setRunHistory: update => set(state => ({
    runHistory: mergeRunHistory(
      state.runHistory,
      typeof update === 'function' ? update(state.runHistory) : update,
    ),
  })),
}));
