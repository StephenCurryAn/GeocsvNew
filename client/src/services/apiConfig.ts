const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() || '/api';

export const API_BASE_URL = configuredBaseUrl.replace(/\/+$/, '');

/** Join an API path to the configured base without normalizing URL templates. */
export const getApiUrl = (path: string): string => {
  const normalizedPath = path.replace(/^\/+/, '');
  return normalizedPath ? `${API_BASE_URL}/${normalizedPath}` : API_BASE_URL;
};
