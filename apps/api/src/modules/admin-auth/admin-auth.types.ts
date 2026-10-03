import type { AdminRole } from '@helmet/types';

export const ADMIN_JWT_AUDIENCE = 'helmet-admin';
export const ADMIN_REFRESH_COOKIE = 'helmet_admin_rt';
export const ADMIN_REFRESH_COOKIE_PATH = '/api/v1/admin/auth';

export interface AdminJwtPayload {
  sub: string;
  role: AdminRole;
  typ: 'admin';
}

/** Authenticated admin attached to the request by AdminJwtGuard. */
export interface AuthenticatedAdmin {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
}
