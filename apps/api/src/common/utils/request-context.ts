import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Network context captured for audit logs and token metadata (IP already hashed). */
export interface RequestMeta {
  ipHash: string | null;
  userAgent: string | null;
}

export const REQUEST_META_KEY = 'requestMeta';

/** Injects the RequestMeta populated by RequestMetaMiddleware. */
export const ReqMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMeta => {
    const req = ctx.switchToHttp().getRequest<Request & { [REQUEST_META_KEY]?: RequestMeta }>();
    return req[REQUEST_META_KEY] ?? { ipHash: null, userAgent: null };
  },
);
