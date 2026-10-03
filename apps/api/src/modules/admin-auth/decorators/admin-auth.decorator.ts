import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Permission } from '@helmet/types';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';
import { RbacGuard } from '../guards/rbac.guard';
import { RequirePermissions } from './roles.decorator';

/**
 * Authenticates an admin access token and enforces the given permissions on the backend.
 * Combine with `@Roles()` for role-pinned routes.
 */
export function AdminAuth(...permissions: Permission[]) {
  return applyDecorators(
    UseGuards(AdminJwtGuard, RbacGuard),
    RequirePermissions(...permissions),
    ApiBearerAuth('admin'),
    ApiUnauthorizedResponse({ description: 'Missing/invalid access token' }),
    ApiForbiddenResponse({ description: 'Insufficient role/permissions' }),
  );
}
