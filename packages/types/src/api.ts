/** Response envelope shared by every API endpoint. */

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export interface ApiErrorBody {
  code: ErrorCode | string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  meta: PaginationMeta;
}

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  HELMET_NOT_FOUND: 'HELMET_NOT_FOUND',
  HELMET_MODEL_NOT_FOUND: 'HELMET_MODEL_NOT_FOUND',
  HELMET_MODEL_ARCHIVED: 'HELMET_MODEL_ARCHIVED',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  BATCH_GENERATION_IN_PROGRESS: 'BATCH_GENERATION_IN_PROGRESS',
  BATCH_ALREADY_GENERATED: 'BATCH_ALREADY_GENERATED',
  BATCH_NOT_GENERATED: 'BATCH_NOT_GENERATED',
  BATCH_ALREADY_PRINTED: 'BATCH_ALREADY_PRINTED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  HELMET_ALREADY_ACTIVATED: 'HELMET_ALREADY_ACTIVATED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
