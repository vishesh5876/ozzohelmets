import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { ApiSuccess, PaginationMeta } from '@helmet/types';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';

/** Marker type: handlers return this to emit `meta` alongside `data`. */
export class PaginatedResult<T> {
  constructor(
    public readonly items: T[],
    public readonly meta: PaginationMeta,
  ) {}
}

@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();
    return next.handle().pipe(
      map((value: unknown): unknown => {
        if (value instanceof StreamableFile || Buffer.isBuffer(value)) return value;
        if (value instanceof PaginatedResult) {
          const body: ApiSuccess<unknown[]> = {
            success: true,
            data: value.items,
            meta: value.meta,
          };
          return body;
        }
        const body: ApiSuccess<unknown> = { success: true, data: value ?? null };
        return body;
      }),
    );
  }
}
