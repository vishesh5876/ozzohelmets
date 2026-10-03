/**
 * Domain enums shared by the API and the web apps.
 * Values MUST match the Prisma schema enums (verified by an API unit test).
 */

export const HelmetStatus = {
  GENERATED: 'GENERATED',
  PRINTED: 'PRINTED',
  IN_INVENTORY: 'IN_INVENTORY',
  SOLD: 'SOLD',
  ACTIVATED: 'ACTIVATED',
  ACTIVE: 'ACTIVE',
  LOST: 'LOST',
  STOLEN: 'STOLEN',
  DAMAGED: 'DAMAGED',
  REPLACED: 'REPLACED',
  DEACTIVATED: 'DEACTIVATED',
  RECALLED: 'RECALLED',
} as const;
export type HelmetStatus = (typeof HelmetStatus)[keyof typeof HelmetStatus];
export const HELMET_STATUSES = Object.values(HelmetStatus);

export const AdminRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MANUFACTURING: 'MANUFACTURING',
  SUPPORT: 'SUPPORT',
  ANALYTICS_VIEWER: 'ANALYTICS_VIEWER',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];
export const ADMIN_ROLES = Object.values(AdminRole);

export const AdminUserStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type AdminUserStatus = (typeof AdminUserStatus)[keyof typeof AdminUserStatus];

export const HelmetModelStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type HelmetModelStatus = (typeof HelmetModelStatus)[keyof typeof HelmetModelStatus];

export const BatchGenerationStatus = {
  PENDING: 'PENDING',
  GENERATING: 'GENERATING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type BatchGenerationStatus =
  (typeof BatchGenerationStatus)[keyof typeof BatchGenerationStatus];

export const BatchPrintStatus = {
  NOT_PRINTED: 'NOT_PRINTED',
  PRINTED: 'PRINTED',
} as const;
export type BatchPrintStatus = (typeof BatchPrintStatus)[keyof typeof BatchPrintStatus];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DELETED: 'DELETED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const OwnershipStatus = {
  ACTIVE: 'ACTIVE',
  TRANSFERRED: 'TRANSFERRED',
  REVOKED: 'REVOKED',
} as const;
export type OwnershipStatus = (typeof OwnershipStatus)[keyof typeof OwnershipStatus];

/** Who triggered a lifecycle change. */
export const ActorType = {
  SYSTEM: 'SYSTEM',
  ADMIN: 'ADMIN',
  OWNER: 'OWNER',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

export const ScanType = {
  EMERGENCY_PAGE: 'EMERGENCY_PAGE',
  VERIFY: 'VERIFY',
  ACTIVATION: 'ACTIVATION',
} as const;
export type ScanType = (typeof ScanType)[keyof typeof ScanType];

/** What the public QR page is allowed to know about a helmet. */
export const PublicHelmetState = {
  NOT_ACTIVATED: 'NOT_ACTIVATED',
  ACTIVE: 'ACTIVE',
  LOST: 'LOST',
  STOLEN: 'STOLEN',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type PublicHelmetState = (typeof PublicHelmetState)[keyof typeof PublicHelmetState];
