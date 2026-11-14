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
      view: { chartType: ResultChartType }; assumptions: string[];
      inputs: { targetName: string; joinName: string };
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

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  status: RunStatus;
  spec: SpatialPivotSpec;
  artifactId: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ArtifactColumn {
  key: string;
  label: string;
}

export interface SpatialPivotArtifact {
  id: string;
  runId: string;
  spec: SpatialPivotSpec;
  columns: ArtifactColumn[];
  totalRows: number;
  summary: {
    targetCount: number;
    joinCount: number;
    matchedPairs: number;
  };
}

export interface SpatialPivotRow {
  featureId: number;
  label: string;
  counts: Record<string, number>;
  total: number;
}

export interface SpatialPivotRows {
  rows: SpatialPivotRow[];
  total: number;
  page: number;
  pageSize: number;
}

export type SpatialPivotGeoJSON = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;

const unwrap = <T>(envelope: ApiEnvelope<T>): T => {
  if (!envelope || ![200, 202].includes(envelope.code)) {
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

export const createAnalysisPlan = async (spec: SpatialPivotSpec, signal?: AbortSignal): Promise<SpatialPivotSpec> => {
  const response = await apiClient.post<ApiEnvelope<SpatialPivotSpec>>('/analysis-plans', spec, { signal });
  return unwrap(response.data);
};

export const createNaturalLanguagePlan = async (
  userPrompt: string,
  fileIds: string[],
  contextRunId?: string,
  signal?: AbortSignal,
): Promise<NaturalLanguagePlan> => {
  const response = await apiClient.post<ApiEnvelope<NaturalLanguagePlan>>('/analysis-plans/natural-language', {
    userPrompt,
    fileIds,
    ...(contextRunId ? { contextRunId } : {}),
  }, { signal });
  return unwrap(response.data);
};

export const createRun = async (spec: SpatialPivotSpec, signal?: AbortSignal): Promise<Run> => {
  const response = await apiClient.post<ApiEnvelope<Run>>('/runs', { spec }, { signal });
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
  const response = await apiClient.get<ApiEnvelope<Run[]>>('/runs', { params: { limit }, signal });
  return unwrap(response.data);
};

export const cancelRun = async (runId: string, signal?: AbortSignal): Promise<void> => {
  await apiClient.post(`/runs/${encodeURIComponent(runId)}/cancel`, undefined, { signal });
};

export const fetchArtifact = async (artifactId: string, signal?: AbortSignal): Promise<SpatialPivotArtifact> => {
  const response = await apiClient.get<ApiEnvelope<SpatialPivotArtifact>>(`/artifacts/${encodeURIComponent(artifactId)}`, { signal });
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

export const downloadArtifactCsv = async (artifactId: string): Promise<void> => {
  const response = await apiClient.get<Blob>(`/artifacts/${encodeURIComponent(artifactId)}/export.csv`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = `spatial-pivot-${artifactId}.csv`;
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
