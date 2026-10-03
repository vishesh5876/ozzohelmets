import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RECENT_AUTH_HEADER } from '../../security/recent-auth.service';

/** Reads the `X-Recent-Auth` header (never a query string or body field). */
export const RecentAuthToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const value = ctx.switchToHttp().getRequest<Request>().headers[RECENT_AUTH_HEADER];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  },
);
