import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedCustomer } from '../customer-auth.types';

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedCustomer => {
    const req = ctx.switchToHttp().getRequest<Request & { customer?: AuthenticatedCustomer }>();
    if (!req.customer) throw new Error('CurrentCustomer used on a route without CustomerJwtGuard');
    return req.customer;
  },
);
