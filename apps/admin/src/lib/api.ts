import { createApiClient, type RequestOptions } from '@helmet/api-client';

export { ApiError, errorMessage } from '@helmet/api-client';

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

const client = createApiClient(API_BASE);

export const configureAuth = client.configureAuth;
export const apiRequest = client.request;
export const apiPage = client.page;
export const apiBlob = client.blob;

export const api = {
  get: client.get,
  post: client.post,
  patch: client.patch,
  page: <T>(path: string, query?: RequestOptions['query']) =>
    client.page<T>(path, { method: 'GET', query }),
};
