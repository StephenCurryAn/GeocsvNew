import apiClient from './apiClient';
import type { ApiEnvelope, DatasetSummary, Run } from './spatialPivotService';

export type Parameters = Record<string, number | string>;
export type Parameter = { description: string } & (
  | { type: 'string'; enum: string[]; default: string }
  | { type: 'integer'; default: number; minimum: number; maximum: number }
);
export interface OperatorInput {
  geometryTypes: string[];
  fields?: Record<string, { type: 'any' | 'numeric'; required: boolean; description: string }>;
}
export interface ModelOperator {
  id: string;
  version: number;
  name: string;
  description: string;
  inputs: Record<string, OperatorInput>;
  parameters: Record<string, Parameter>;
}
export interface ModelConfig {
  name: string;
  description: string;
  operator: Pick<ModelOperator, 'id' | 'version'>;
  parameters: Parameters;
}
export interface ProfessionalModel extends ModelConfig {
  id: string;
  version: number;
  revision: string;
  operator: ModelOperator;
  publishedAt: string | null;
  trialRunId: string | null;
}
export type ModelInputs = Record<string, { fileId: string; [field: string]: string }>;
export type ModelDataset = DatasetSummary & { numericFields: string[] };
export type ModelLayer = Pick<DatasetSummary, 'fileId' | 'name'>;

const root = '/professional-models';
const manage = root + '/manage';
const modelPath = ({ id, version }: ProfessionalModel) => '/' + id + '/' + version;
const scenePath = (sceneId: string) => '/scenes/' + encodeURIComponent(sceneId) + root;
const auth = (token: string) => ({ Authorization: 'Bearer ' + token });

export const professionalModelService = {
  async catalog(signal?: AbortSignal) {
    return (await apiClient.get<ApiEnvelope<ProfessionalModel[]>>(root, { signal })).data.data;
  },
  async management(token: string) {
    return (await apiClient.get<ApiEnvelope<{ models: ProfessionalModel[]; operators: ModelOperator[] }>>(
      manage, { headers: auth(token) },
    )).data.data;
  },
  async save(token: string, config: ModelConfig, draft?: ProfessionalModel) {
    const headers = auth(token);
    const response = draft
      ? await apiClient.put<ApiEnvelope<ProfessionalModel>>(manage + modelPath(draft), { ...config, revision: draft.revision }, { headers })
      : await apiClient.post<ApiEnvelope<ProfessionalModel>>(manage, config, { headers });
    return response.data.data;
  },
  async nextDraft(token: string, model: ProfessionalModel) {
    return (await apiClient.post<ApiEnvelope<ProfessionalModel>>(manage + modelPath(model) + '/next',
      undefined, { headers: auth(token) })).data.data;
  },
  async publish(token: string, draft: ProfessionalModel) {
    return (await apiClient.post<ApiEnvelope<ProfessionalModel>>(manage + modelPath(draft) + '/publish',
      { revision: draft.revision }, { headers: auth(token) })).data.data;
  },
  async layers(sceneId: string, signal: AbortSignal) {
    return (await apiClient.get<ApiEnvelope<ModelLayer[]>>(scenePath(sceneId) + '/datasets', { signal })).data.data;
  },
  async dataset(sceneId: string, fileId: string, signal: AbortSignal) {
    return (await apiClient.get<ApiEnvelope<ModelDataset>>(scenePath(sceneId) + '/datasets/' + encodeURIComponent(fileId),
      { signal })).data.data;
  },
  async runs(sceneId: string, signal: AbortSignal) {
    return (await apiClient.get<ApiEnvelope<Run[]>>(scenePath(sceneId) + '/runs', { signal })).data.data;
  },
  async run(sceneId: string, model: ProfessionalModel, inputs: ModelInputs, key: string, token?: string) {
    return (await apiClient.post<ApiEnvelope<Run>>(scenePath(sceneId) + modelPath(model) + '/runs', {
      revision: model.revision, purpose: token ? 'trial' : 'run', inputs,
    }, { headers: { 'Idempotency-Key': key, ...(token ? auth(token) : {}) } })).data.data;
  },
};
