import { type AdminRole } from './enums';

/**
 * Fine-grained admin permissions. Roles map to permission sets; the API enforces them,
 * the web apps only use them to hide UI that would be rejected anyway.
 */
export const Permission = {
  DASHBOARD_READ: 'dashboard:read',
  MODELS_READ: 'models:read',
  MODELS_WRITE: 'models:write',
  BATCHES_READ: 'batches:read',
  BATCHES_WRITE: 'batches:write',
  BATCHES_GENERATE: 'batches:generate',
  HELMETS_READ: 'helmets:read',
  HELMETS_UPDATE_STATUS: 'helmets:update-status',
  LABELS_READ: 'labels:read',
  EXPORT_MANUFACTURING: 'export:manufacturing',
  AUDIT_READ: 'audit:read',
  OWNERSHIP_VIEW: 'ownership:view',
  OWNERSHIP_REVOKE: 'ownership:revoke',
  TRANSFER_CANCEL: 'transfer:cancel',
  REPLACEMENT_MANAGE: 'replacement:manage',
  HELMET_LIFECYCLE_MANAGE: 'helmet-lifecycle:manage',
  ADMIN_USERS_MANAGE: 'admin-users:manage',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: ALL,
  // Revoking a customer's ownership is reserved for SUPER_ADMIN.
  ADMIN: ALL.filter(
    (p) => p !== Permission.ADMIN_USERS_MANAGE && p !== Permission.OWNERSHIP_REVOKE,
  ),
  MANUFACTURING: [
    Permission.DASHBOARD_READ,
    Permission.MODELS_READ,
    Permission.MODELS_WRITE,
    Permission.BATCHES_READ,
    Permission.BATCHES_WRITE,
    Permission.BATCHES_GENERATE,
    Permission.HELMETS_READ,
    Permission.HELMETS_UPDATE_STATUS,
    Permission.LABELS_READ,
  ],
  SUPPORT: [
    Permission.DASHBOARD_READ,
    Permission.MODELS_READ,
    Permission.BATCHES_READ,
    Permission.HELMETS_READ,
    Permission.LABELS_READ,
    Permission.OWNERSHIP_VIEW,
    Permission.TRANSFER_CANCEL,
    Permission.REPLACEMENT_MANAGE,
    Permission.HELMET_LIFECYCLE_MANAGE,
  ],
  ANALYTICS_VIEWER: [
    Permission.DASHBOARD_READ,
    Permission.MODELS_READ,
    Permission.BATCHES_READ,
    Permission.HELMETS_READ,
  ],
};

export function roleHasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
