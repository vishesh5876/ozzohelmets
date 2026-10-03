import { SetMetadata } from '@nestjs/common';
import type { AdminRole, Permission } from '@helmet/types';

export const ROLES_KEY = 'rbac:roles';
export const PERMISSIONS_KEY = 'rbac:permissions';

/** Restrict a route to specific roles, e.g. `@Roles(AdminRole.SUPER_ADMIN)`. */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/** Require every listed permission (resolved from the admin's role). */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
