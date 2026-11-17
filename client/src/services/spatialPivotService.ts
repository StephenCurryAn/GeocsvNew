import apiClient from './apiClient';
import { unwrapAnalysisResponse, type ApiEnvelope, type DatasetSummary,
  type SpatialPivotPlan, type SpatialPivotSpec } from './analysisService';

export const fetchDatasets = async (fileIds: string[], signal?: AbortSignal): Promise<DatasetSummary[]> => {
  if (fileIds.length === 0) return [];
  const response = await apiClient.get<ApiEnvelope<DatasetSummary[]>>('/datasets', {
    params: { ids: fileIds.join(',') }, signal,
  });
  return unwrapAnalysisResponse(response.data);
};

export const createAnalysisPlan = async (spec: SpatialPivotSpec, signal?: AbortSignal): Promise<SpatialPivotPlan> => {
  const response = await apiClient.post<ApiEnvelope<SpatialPivotPlan>>('/analysis/plans', { spec }, { signal });
  return unwrapAnalysisResponse(response.data);
};
