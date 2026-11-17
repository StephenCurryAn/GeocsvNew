import axios from 'axios';
import apiClient from './apiClient';

export interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}

export interface DatasetSummary {
  fileId: string;
  name: string;
  featureCount: number;
  geometryTypes: string[];
  fields: string[];
}

export type BoundaryPolicy = 'exclude' | 'include';
export type ResultChartType = 'bar' | 'line' | 'pie';

export type NaturalLanguagePlan =
  | {
      status: 'ready'; source: 'rules' | 'llm'; message: string; spec: SpatialPivotSpec;
      plan: SpatialPivotPlan;
      view: { chartType: ResultChartType }; assumptions: string[];
      inputs: { targetName: string; joinName: string };
    }
  | {
      status: 'ready'; source: 'llm'; message: string;
      confirmationStatus: 'pending_confirmation'; spec: MoranSpec;
      plan: AnalysisPlan<MoranSpec>; inputs: { targetName: string; metricLabel?: string; dataMonth?: string };
    }
  | { status: 'clarification'; message: string; questions: string[] }
  | { status: 'unsupported'; message: string }
  | {
      status: 'view_only'; message: string; runId: string; artifactId: string;
      view: { chartType: ResultChartType };
    };

export interface SpatialPivotSpec {
  schemaVersion: 1;
  kind: 'spatial_pivot';
  operatorVersion: 1;
  target: { fileId: string; labelField: string | null };
  join: { fileId: string; categoryField: string | null };
  boundaryPolicy: BoundaryPolicy;
}

export interface MoranSpec {
  schemaVersion: 1;
  kind: 'spatial_autocorrelation';
  operatorVersion: 2;
  target: { fileId: string; valueField: string; labelField?: string };
  contiguity: 'queen' | 'rook';
  permutations: number;
  seed: number;
}

export type AnalysisSpec = SpatialPivotSpec | MoranSpec;

export interface AnalysisPlan<TSpec extends AnalysisSpec = AnalysisSpec> {
  id: string;
  version: number;
  spec: TSpec;
  status: 'validated' | 'confirmed';
}

export type SpatialPivotPlan = AnalysisPlan<SpatialPivotSpec>;

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  status: RunStatus;
  spec: AnalysisSpec;
  artifactId: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  professionalModel?: {
    id: string;
    version: number;
    revision: string;
    name: string;
    sceneId: string;
    purpose: 'trial' | 'run';
  };
}

export interface ArtifactColumn {
  key: string;
  label: string;
}

export interface SpatialPivotArtifact {
  id: string;
  runId: string;
  spec: SpatialPivotSpec;
  format: 'spatial_counts';
  columns: ArtifactColumn[];
  totalRows: number;
  summary: {
    targetCount: number;
    joinCount: number;
    matchedPairs: number;
  };
}

export interface MoranArtifact {
  id: string;
  runId: string;
  format: 'moran_lisa';
  spec: MoranSpec;
  columns: ArtifactColumn[];
  totalRows: number;
  summary: {
    globalI: number;
    expectedI: number;
    pValue: number | null;
    excludedValueIds: number[];
  };
}

export type AnalysisArtifact = SpatialPivotArtifact | MoranArtifact;
export type MoranQuadrant = 'HH' | 'HL' | 'LH' | 'LL';

export interface MoranRow {
  featureId: number;
  label: string | null;
  localI: number;
  pValue: number | null;
  quadrant: MoranQuadrant | null;
  neighborCount: number;
}

export interface SpatialPivotRow {
  featureId: number;
  label: string;
  counts: Record<string, number>;
  total: number;
}

export interface SpatialPivotRows {
  rows: (SpatialPivotRow | MoranRow)[];
  total: number;
  page: number;
  pageSize: number;
}

export type SpatialPivotGeoJSON = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;

const unwrap = <T>(envelope: ApiEnvelope<T>): T => {
  if (!envelope || ![200, 201, 202].includes(envelope.code)) {
    throw new Error(envelope?.message || '空间透视请求失败');
  }
  return envelope.data;
};

export const fetchDatasets = async (fileIds: string[], signal?: AbortSignal): Promise<DatasetSummary[]> => {
  if (fileIds.length === 0) return [];
  const response = await apiClient.get<ApiEnvelope<DatasetSummary[]>>('/datasets', {
    params: { ids: fileIds.join(',') }, signal,
  });
  return unwrap(response.data);
};

export const createAnalysisPlan = async (spec: SpatialPivotSpec, signal?: AbortSignal): Promise<SpatialPivotPlan> => {
  const response = await apiClient.post<ApiEnvelope<SpatialPivotPlan>>('/analysis/plans', { spec }, { signal });
  return unwrap(response.data);
};

export const createNaturalLanguagePlan = async (
  sceneId: string,
  input: { userPrompt: string; fileIds: string[]; contextRunId?: string; contextPlanId?: string },
  signal?: AbortSignal,
): Promise<NaturalLanguagePlan> => {
  const response = await apiClient.post<ApiEnvelope<NaturalLanguagePlan>>(
    `/scenes/${encodeURIComponent(sceneId)}/analysis/plans/natural-language`, input, { signal },
  );
  return unwrap(response.data);
};

// The current plan keeps its request key across transport failures and retries.
const requestKeys = new WeakMap<SpatialPivotPlan, string>();
const requestKeyFor = (plan: SpatialPivotPlan): string => {
  const existing = requestKeys.get(plan);
  if (existing) return existing;
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  requestKeys.set(plan, key);
  return key;
};

export const createRun = async (plan: SpatialPivotPlan, signal?: AbortSignal): Promise<Run> => {
  const response = await apiClient.post<ApiEnvelope<Run>>('/runs', {
    planId: plan.id, planVersion: plan.version,
  }, { signal, headers: { 'Idempotency-Key': requestKeyFor(plan) } });
  if (response.status !== 202 && response.data.code !== 202) {
    throw new Error(response.data.message || '服务器未接受分析任务');
  }
  return unwrap(response.data);
};

export const fetchRun = async (runId: string, signal?: AbortSignal): Promise<Run> => {
  const response = await apiClient.get<ApiEnvelope<Run>>(`/runs/${encodeURIComponent(runId)}`, { signal });
  return unwrap(response.data);
};

export const fetchRuns = async (limit = 20, signal?: AbortSignal): Promise<Run[]> => {
  const response = await apiClient.get<ApiEnvelope<Run[]>>('/runs', { params: { limit, operator: 'spatial_pivot' }, signal });
  return unwrap(response.data);
};

export const cancelRun = async (runId: string, signal?: AbortSignal): Promise<void> => {
  await apiClient.post(`/runs/${encodeURIComponent(runId)}/cancel`, undefined, { signal });
};

export const fetchArtifact = async (artifactId: string, signal?: AbortSignal): Promise<AnalysisArtifact> => {
  const response = await apiClient.get<ApiEnvelope<AnalysisArtifact>>(`/artifacts/${encodeURIComponent(artifactId)}`, { signal });
  return unwrap(response.data);
};

export const fetchArtifactRows = async (
  artifactId: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<SpatialPivotRows> => {
  const response = await apiClient.get<ApiEnvelope<SpatialPivotRows>>(
    `/artifacts/${encodeURIComponent(artifactId)}/rows`, { params: { page, pageSize }, signal },
  );
  return unwrap(response.data);
};

export const fetchArtifactGeoJSON = async (artifactId: string, signal?: AbortSignal): Promise<SpatialPivotGeoJSON> => {
  const response = await apiClient.get<SpatialPivotGeoJSON>(
    `/artifacts/${encodeURIComponent(artifactId)}/geojson`, { signal },
  );
  return response.data;
};

export const downloadArtifactCsv = async (artifactId: string, format: AnalysisArtifact['format'] = 'spatial_counts'): Promise<void> => {
  const response = await apiClient.get<Blob>(`/artifacts/${encodeURIComponent(artifactId)}/export.csv`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${format === 'moran_lisa' ? 'moran-lisa' : 'spatial-pivot'}-${artifactId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

export const getRequestErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const responseBody: unknown = error.response?.data;
    if (responseBody && typeof responseBody === 'object') {
      const payload = responseBody as { message?: unknown; details?: unknown };
      if (typeof payload.message === 'string') return payload.message;
      if (typeof payload.details === 'string') return payload.details;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return '请求失败，请检查服务状态后重试';
};
