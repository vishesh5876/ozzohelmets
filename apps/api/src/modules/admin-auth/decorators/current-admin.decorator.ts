import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedAdmin } from '../admin-auth.types';

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const req = ctx.switchToHttp().getRequest<Request & { admin?: AuthenticatedAdmin }>();
    if (!req.admin) throw new Error('CurrentAdmin used on a route without AdminJwtGuard');
    return req.admin;
  },
);
