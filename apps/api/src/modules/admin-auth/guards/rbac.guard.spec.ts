import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole, Permission, ROLE_PERMISSIONS } from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import { PERMISSIONS_KEY, ROLES_KEY } from '../decorators/roles.decorator';
import { RbacGuard } from './rbac.guard';

function context(
  role: AdminRole | null,
  meta: { roles?: AdminRole[]; permissions?: Permission[] },
): ExecutionContext {
  const handler = () => undefined;
  if (meta.roles) Reflect.defineMetadata(ROLES_KEY, meta.roles, handler);
  if (meta.permissions) Reflect.defineMetadata(PERMISSIONS_KEY, meta.permissions, handler);
  class Controller {}
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({
      getRequest: () => ({ admin: role ? { id: 'x', name: 'x', email: 'x', role } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('RbacGuard', () => {
  const guard = new RbacGuard(new Reflector());

  it('allows SUPER_ADMIN everything', () => {
    for (const permission of Object.values(Permission)) {
      expect(guard.canActivate(context(AdminRole.SUPER_ADMIN, { permissions: [permission] }))).toBe(
        true,
      );
    }
  });

  it('restricts manufacturing PIN export to SUPER_ADMIN and ADMIN', () => {
    const allowed = Object.values(AdminRole).filter((role) =>
      ROLE_PERMISSIONS[role].includes(Permission.EXPORT_MANUFACTURING),
    );
    expect(allowed.sort()).toEqual([AdminRole.ADMIN, AdminRole.SUPER_ADMIN].sort());
    expect(() =>
      guard.canActivate(
        context(AdminRole.MANUFACTURING, { permissions: [Permission.EXPORT_MANUFACTURING] }),
      ),
    ).toThrow(AppException);
    expect(() =>
      guard.canActivate(
        context(AdminRole.SUPPORT, { permissions: [Permission.EXPORT_MANUFACTURING] }),
      ),
    ).toThrow(AppException);
  });

  it('enforces @Roles()', () => {
    expect(
      guard.canActivate(context(AdminRole.SUPER_ADMIN, { roles: [AdminRole.SUPER_ADMIN] })),
    ).toBe(true);
    expect(() =>
      guard.canActivate(context(AdminRole.ADMIN, { roles: [AdminRole.SUPER_ADMIN] })),
    ).toThrow(AppException);
  });

  it('requires every listed permission', () => {
    const ctx = context(AdminRole.ANALYTICS_VIEWER, {
      permissions: [Permission.HELMETS_READ, Permission.HELMETS_UPDATE_STATUS],
    });
    expect(() => guard.canActivate(ctx)).toThrow(AppException);
  });

  it('only SUPER_ADMIN manages admin users', () => {
    for (const role of Object.values(AdminRole)) {
      const ctx = context(role, { permissions: [Permission.ADMIN_USERS_MANAGE] });
      if (role === AdminRole.SUPER_ADMIN) expect(guard.canActivate(ctx)).toBe(true);
      else expect(() => guard.canActivate(ctx)).toThrow(AppException);
    }
  });

  it('rejects unauthenticated requests', () => {
    expect(() => guard.canActivate(context(null, {}))).toThrow(AppException);
  });

  it('read-only roles cannot mutate catalogue or batches', () => {
    for (const role of [AdminRole.SUPPORT, AdminRole.ANALYTICS_VIEWER]) {
      for (const p of [
        Permission.MODELS_WRITE,
        Permission.BATCHES_WRITE,
        Permission.BATCHES_GENERATE,
        Permission.HELMETS_UPDATE_STATUS,
      ]) {
        expect(() => guard.canActivate(context(role, { permissions: [p] }))).toThrow(AppException);
      }
    }
  });
});
