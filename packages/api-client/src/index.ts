import type { ApiFailure, ApiSuccess, PaginationMeta } from '@helmet/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type QueryValue = string | number | boolean | undefined | null | string[];

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Internal: prevents infinite refresh loops. */
  retried?: boolean;
}

export interface TokenProvider {
  getToken: () => string | null;
  /** Attempts a silent refresh; resolves to the new token or null. */
  refresh: () => Promise<string | null>;
}

export interface ApiClient {
  readonly baseUrl: string;
  configureAuth(provider: TokenProvider): void;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  page<T>(path: string, options?: RequestOptions): Promise<{ items: T[]; meta: PaginationMeta }>;
  blob(path: string, options?: RequestOptions): Promise<{ blob: Blob; headers: Headers }>;
  get<T>(path: string, query?: RequestOptions['query']): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  /** Multipart upload (FormData). */
  upload<T>(path: string, form: FormData, method?: 'POST' | 'PUT'): Promise<T>;
}

/**
 * Fetch client that unwraps `{ success, data, meta }`, throws ApiError with the server's error
 * code, sends the CSRF header used by cookie endpoints, and retries once after a silent refresh
 * when an authenticated request returns 401.
 */
export function createApiClient(baseUrl: string): ApiClient {
  let tokens: TokenProvider = { getToken: () => null, refresh: async () => null };

  const buildUrl = (path: string, query?: RequestOptions['query']): string => {
    const url = `${baseUrl}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  };

  const send = async (path: string, options: RequestOptions): Promise<Response> => {
    const { body, query, retried, headers, ...init } = options;
    const token = tokens.getToken();
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(buildUrl(path, query), {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    if (res.status === 401 && !retried && token) {
      const fresh = await tokens.refresh();
      if (fresh) return send(path, { ...options, retried: true });
    }
    return res;
  };

  const toError = async (res: Response): Promise<ApiError> => {
    try {
      const body = (await res.json()) as ApiFailure;
      return new ApiError(res.status, body.error.code, body.error.message, body.error.details);
    } catch {
      return new ApiError(res.status, 'NETWORK_ERROR', res.statusText || 'Request failed');
    }
  };

  const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    const res = await send(path, options);
    if (!res.ok) throw await toError(res);
    return ((await res.json()) as ApiSuccess<T>).data;
  };

  return {
    baseUrl,
    configureAuth: (provider) => {
      tokens = provider;
    },
    request,
    page: async <T>(path: string, options: RequestOptions = {}) => {
      const res = await send(path, options);
      if (!res.ok) throw await toError(res);
      const body = (await res.json()) as ApiSuccess<T[]>;
      return { items: body.data, meta: body.meta ?? { page: 1, pageSize: body.data.length, total: body.data.length, totalPages: 1 } };
    },
    blob: async (path, options = {}) => {
      const res = await send(path, { ...options, headers: { Accept: '*/*', ...options.headers } });
      if (!res.ok) throw await toError(res);
      return { blob: await res.blob(), headers: res.headers };
    },
    get: (path, query) => request(path, { method: 'GET', query }),
    post: (path, body) => request(path, { method: 'POST', body }),
    put: (path, body) => request(path, { method: 'PUT', body }),
    patch: (path, body) => request(path, { method: 'PATCH', body }),
    delete: (path) => request(path, { method: 'DELETE' }),
    upload: (path, form, method = 'PUT') => request(path, { method, body: form }),
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/**
 * Single-flight cookie refresh: concurrent 401s share one request, because refresh tokens
 * rotate on every use and parallel refreshes would trip reuse detection.
 */
export function createRefresher<T extends { accessToken: string }>(url: string, onResult: (session: T | null) => void): () => Promise<string | null> {
  let inFlight: Promise<string | null> | null = null;
  return () => {
    inFlight ??= fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) {
          onResult(null);
          return null;
        }
        const body = (await res.json()) as { data: T };
        onResult(body.data);
        return body.data.accessToken;
      })
      .catch(() => {
        onResult(null);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
