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
  WARRANTY_VIEW: 'warranty:view',
  WARRANTY_MANAGE: 'warranty:manage',
  WARRANTY_VOID: 'warranty:void',
  WARRANTY_DOCUMENT_VIEW: 'warranty:document-view',
  PRODUCT_REPORT_VIEW: 'product-report:view',
  PRODUCT_REPORT_MANAGE: 'product-report:manage',
  ADMIN_USERS_MANAGE: 'admin-users:manage',
  // Phase 5 — customer support, privacy, security.
  /** Search customers and view the operational account summary (never medical data). */
  CUSTOMERS_READ: 'customers:read',
  /** Suspend / lock / restore accounts and force sign-out. */
  CUSTOMERS_MANAGE: 'customers:manage',
  /** Irreversible administrative action: mark an account deleted. */
  CUSTOMERS_DELETE: 'customers:delete',
  /** Issue a last-resort Account Recovery Grant. */
  CUSTOMER_RECOVERY_GRANT: 'customer-recovery:grant',
  PRIVACY_REQUESTS_VIEW: 'privacy-requests:view',
  /** Approve / reject / complete account deletion requests. */
  PRIVACY_REQUESTS_MANAGE: 'privacy-requests:manage',
  /** View customer security events (login failures, recoveries, grants). */
  SECURITY_EVENTS_VIEW: 'security-events:view',
  // Phase 6 — analytics and QR abuse detection.
  /** Aggregate operational analytics (never medical data, never visitor identities). */
  ANALYTICS_VIEW: 'analytics:view',
  RISK_ALERT_VIEW: 'risk-alert:view',
  /** Acknowledge / investigate / resolve / dismiss / assign risk alerts. */
  RISK_ALERT_MANAGE: 'risk-alert:manage',
  /** Mark a printed QR under review / compromised (human decision; no lifecycle effect). */
  QR_INTEGRITY_MANAGE: 'qr-integrity:manage',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

/** Permissions only SUPER_ADMIN holds: irreversible or last-resort account actions. */
export const SUPER_ADMIN_ONLY: readonly Permission[] = [
  Permission.ADMIN_USERS_MANAGE,
  Permission.OWNERSHIP_REVOKE,
  Permission.WARRANTY_DOCUMENT_VIEW,
  Permission.CUSTOMERS_DELETE,
  Permission.CUSTOMER_RECOVERY_GRANT,
  Permission.PRIVACY_REQUESTS_MANAGE,
  Permission.SECURITY_EVENTS_VIEW,
];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: ALL,
  // ADMIN: everything except the SUPER_ADMIN-only set (proof documents: SUPER_ADMIN + SUPPORT).
  ADMIN: ALL.filter((p) => !SUPER_ADMIN_ONLY.includes(p)),
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
    // Warranty view + corrections + documents, but not void/restore.
    Permission.WARRANTY_VIEW,
    Permission.WARRANTY_MANAGE,
    Permission.WARRANTY_DOCUMENT_VIEW,
    Permission.PRODUCT_REPORT_VIEW,
    Permission.PRODUCT_REPORT_MANAGE,
    // Customer support: find accounts, suspend/restore, force sign-out. Never medical data,
    // never recovery grants, never deletion.
    Permission.CUSTOMERS_READ,
    Permission.CUSTOMERS_MANAGE,
    Permission.PRIVACY_REQUESTS_VIEW,
    // Analytics + alert investigation, but not QR integrity decisions.
    Permission.ANALYTICS_VIEW,
    Permission.RISK_ALERT_VIEW,
    Permission.RISK_ALERT_MANAGE,
  ],
  ANALYTICS_VIEWER: [
    Permission.DASHBOARD_READ,
    Permission.MODELS_READ,
    Permission.BATCHES_READ,
    Permission.HELMETS_READ,
    Permission.ANALYTICS_VIEW,
  ],
};

export function roleHasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
