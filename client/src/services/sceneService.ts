import apiClient from './apiClient';

export interface Scene {
  id: string;
  name: string;
  isDefault: boolean;
}

export const sceneFilesPath = (sceneId: string) => `/scenes/${encodeURIComponent(sceneId)}/files`;

export const sceneService = {
  async list(signal: AbortSignal): Promise<Scene[]> {
    const response = await apiClient.get<{ data: Scene[] }>('/scenes', { signal });
    return response.data.data;
  },
  async create(name: string): Promise<Scene> {
    const response = await apiClient.post<{ data: Scene }>('/scenes', { name });
    return response.data.data;
  },
};
