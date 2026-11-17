import apiClient from './apiClient';
import type { ApiEnvelope, NaturalLanguagePlan, Run } from './spatialPivotService';

export interface AnalysisSession {
  threadId: string;
  sceneId: string;
  status: 'processing' | 'clarification' | 'pending_confirmation' | 'submitted' | 'cancelled' | 'unsupported' | 'view_only';
  interactionId?: string | null;
  prompt: string;
  proposal?: NaturalLanguagePlan | null;
  runId?: string | null;
}

export interface AnalysisSessionEvent {
  action: 'start' | 'answer' | 'confirm' | 'cancel' | 'resume';
  requestId: string;
  prompt?: string;
  interactionId?: string;
  contextRunId?: string;
}

const sessionPath = (sceneId: string, threadId: string) =>
  `/scenes/${encodeURIComponent(sceneId)}/analysis/sessions/${encodeURIComponent(threadId)}`;

export async function fetchAnalysisSession(sceneId: string, threadId: string, signal?: AbortSignal) {
  const response = await apiClient.get<ApiEnvelope<AnalysisSession>>(sessionPath(sceneId, threadId), { signal });
  return response.data.data;
}

export async function sendAnalysisEvent(sceneId: string, threadId: string, event: AnalysisSessionEvent, signal?: AbortSignal) {
  const response = await apiClient.post<ApiEnvelope<AnalysisSession>>(sessionPath(sceneId, threadId) + '/events',
    event, { signal, timeout: 55000 });
  return response.data.data;
}

export async function fetchSceneRuns(sceneId: string, signal?: AbortSignal) {
  const response = await apiClient.get<ApiEnvelope<Run[]>>(`/scenes/${encodeURIComponent(sceneId)}/analysis/runs`, { signal });
  return response.data.data;
}
