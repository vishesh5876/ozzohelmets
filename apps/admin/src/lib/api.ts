import type { ApiFailure, ApiSuccess, PaginationMeta } from '@helmet/types';

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

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

type TokenProvider = {
  getToken: () => string | null;
  /** Attempts a silent refresh; resolves to the new token or null. */
  refresh: () => Promise<string | null>;
};

let tokens: TokenProvider = { getToken: () => null, refresh: async () => null };

export function configureAuth(provider: TokenProvider): void {
  tokens = provider;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  /** Internal: prevents infinite refresh loops. */
  retried?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { body, query, retried, headers, ...init } = options;
  const token = tokens.getToken();
  const res = await fetch(buildUrl(path, query), {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'fetch',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried && token) {
    const fresh = await tokens.refresh();
    if (fresh) return send(path, { ...options, retried: true });
  }
  return res;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiFailure;
    return new ApiError(res.status, body.error.code, body.error.message, body.error.details);
  } catch {
    return new ApiError(res.status, 'NETWORK_ERROR', res.statusText || 'Request failed');
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await send(path, options);
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as ApiSuccess<T>;
  return body.data;
}

export async function apiPage<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ items: T[]; meta: PaginationMeta }> {
  const res = await send(path, options);
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as ApiSuccess<T[]>;
  return {
    items: body.data,
    meta: body.meta ?? {
      page: 1,
      pageSize: body.data.length,
      total: body.data.length,
      totalPages: 1,
    },
  };
}

/** Authenticated binary download (images, CSV). */
export async function apiBlob(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; headers: Headers }> {
  const res = await send(path, { ...options, headers: { Accept: '*/*', ...options.headers } });
  if (!res.ok) throw await toError(res);
  return { blob: await res.blob(), headers: res.headers };
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) =>
    apiRequest<T>(path, { method: 'GET', query }),
  page: <T>(path: string, query?: RequestOptions['query']) =>
    apiPage<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
