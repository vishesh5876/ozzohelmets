import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type AdminRole, type Permission, roleHasPermission } from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import type { AuthenticatedAdmin } from '../admin-auth.types';
import { PERMISSIONS_KEY, ROLES_KEY } from '../decorators/roles.decorator';

/** Backend-enforced role/permission check. Must run after AdminJwtGuard. */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const roles =
      this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, targets) ?? [];
    const permissions = this.reflector.getAllAndMerge<Permission[]>(PERMISSIONS_KEY, targets) ?? [];

    const admin = context
      .switchToHttp()
      .getRequest<Request & { admin?: AuthenticatedAdmin }>().admin;
    if (!admin) throw AppException.unauthorized();

    if (roles.length > 0 && !roles.includes(admin.role)) throw AppException.forbidden();
    if (!permissions.every((p) => roleHasPermission(admin.role, p))) throw AppException.forbidden();
    return true;
  }
}
