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
/** Customer account status (customers live in the `users` table). */
export const CustomerStatus = UserStatus;
export type CustomerStatus = UserStatus;

export const OwnershipStatus = {
  ACTIVE: 'ACTIVE',
  TRANSFERRED: 'TRANSFERRED',
  REVOKED: 'REVOKED',
} as const;
export type OwnershipStatus = (typeof OwnershipStatus)[keyof typeof OwnershipStatus];

export const OwnershipAcquisition = {
  ACTIVATION: 'ACTIVATION',
  TRANSFER: 'TRANSFER',
} as const;
export type OwnershipAcquisition = (typeof OwnershipAcquisition)[keyof typeof OwnershipAcquisition];

export const TransferStatus = {
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];

export const ReplacementReason = {
  DAMAGED: 'DAMAGED',
  DEFECTIVE: 'DEFECTIVE',
  ACCIDENT: 'ACCIDENT',
  SUPPORT_REPLACEMENT: 'SUPPORT_REPLACEMENT',
  OTHER: 'OTHER',
} as const;
export type ReplacementReason = (typeof ReplacementReason)[keyof typeof ReplacementReason];

/** Optional reason when an owner marks a helmet damaged (no free-text required). */
export const DamageReason = {
  ACCIDENT: 'ACCIDENT',
  IMPACT: 'IMPACT',
  CRACKED: 'CRACKED',
  OTHER: 'OTHER',
} as const;
export type DamageReason = (typeof DamageReason)[keyof typeof DamageReason];

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
  ACTIVATED_PROFILE_INCOMPLETE: 'ACTIVATED_PROFILE_INCOMPLETE',
  ACTIVE: 'ACTIVE',
  LOST: 'LOST',
  STOLEN: 'STOLEN',
  DAMAGED: 'DAMAGED',
  REPLACED: 'REPLACED',
  DEACTIVATED: 'DEACTIVATED',
  RECALLED: 'RECALLED',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type PublicHelmetState = (typeof PublicHelmetState)[keyof typeof PublicHelmetState];
export const PublicEmergencyState = PublicHelmetState;
export type PublicEmergencyState = PublicHelmetState;

export const BloodGroup = {
  A_POSITIVE: 'A_POSITIVE',
  A_NEGATIVE: 'A_NEGATIVE',
  B_POSITIVE: 'B_POSITIVE',
  B_NEGATIVE: 'B_NEGATIVE',
  AB_POSITIVE: 'AB_POSITIVE',
  AB_NEGATIVE: 'AB_NEGATIVE',
  O_POSITIVE: 'O_POSITIVE',
  O_NEGATIVE: 'O_NEGATIVE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type BloodGroup = (typeof BloodGroup)[keyof typeof BloodGroup];
export const BLOOD_GROUPS = Object.values(BloodGroup);
export const BLOOD_GROUP_LABELS: Record<BloodGroup, string> = {
  A_POSITIVE: 'A+',
  A_NEGATIVE: 'A-',
  B_POSITIVE: 'B+',
  B_NEGATIVE: 'B-',
  AB_POSITIVE: 'AB+',
  AB_NEGATIVE: 'AB-',
  O_POSITIVE: 'O+',
  O_NEGATIVE: 'O-',
  UNKNOWN: 'Unknown',
};

export const Gender = {
  FEMALE: 'FEMALE',
  MALE: 'MALE',
  NON_BINARY: 'NON_BINARY',
  OTHER: 'OTHER',
  PREFER_NOT_TO_SAY: 'PREFER_NOT_TO_SAY',
} as const;
export type Gender = (typeof Gender)[keyof typeof Gender];
export const GENDERS = Object.values(Gender);

/** Owner-facing / admin-facing summary of the emergency profile (never contains medical data). */
export const EmergencyProfileStatus = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  INCOMPLETE: 'INCOMPLETE',
  DISABLED: 'DISABLED',
  ACTIVE: 'ACTIVE',
} as const;
export type EmergencyProfileStatus =
  (typeof EmergencyProfileStatus)[keyof typeof EmergencyProfileStatus];

/** Requirements that must all be met before the emergency profile can be enabled. */
export const ReadinessRequirement = {
  NAME: 'NAME',
  EMERGENCY_CONTACT: 'EMERGENCY_CONTACT',
  PRIVACY_REVIEW: 'PRIVACY_REVIEW',
} as const;
export type ReadinessRequirement = (typeof ReadinessRequirement)[keyof typeof ReadinessRequirement];
