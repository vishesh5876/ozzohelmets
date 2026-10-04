/**
 * Phase 5 contracts: customer dashboard health, account security & activity, privacy requests,
 * admin customer support, recovery grants, operational dashboards and audit labels.
 */
import type {
  AccountDeletionStatus,
  CustomerSecurityEventType,
  HelmetStatus,
  OwnershipAcquisition,
  OwnershipStatus,
  ProductReportEventType,
  ProductReportPriority,
  UserStatus,
  WarrantyStatus,
} from './enums';
import type { PublicEmergencyDto } from './contracts';

type IsoDateString = string;

// ─────────────── Device summary (no fingerprinting) ───────────────

const SUMMARY_SHAPE = /^(?:[A-Za-z]+(?: [A-Za-z]+)? on [A-Za-z ]+|Other device)$/;

/**
 * Coarse "Browser on OS" description. This is all that is stored for sessions and security
 * events: no full user-agent string, no versions, no device model.
 */
export function summarizeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  // Already a summary (what we store): return unchanged so reading never degrades it.
  if (SUMMARY_SHAPE.test(ua)) return ua;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/i.test(ua)
        ? 'macOS'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /CrOS/i.test(ua)
            ? 'ChromeOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  if (!os && !browser) return 'Other device';
  return `${browser ?? 'Browser'} on ${os ?? 'unknown OS'}`;
}

// ─────────────── Customer security events ───────────────

export const SECURITY_EVENT_LABELS: Record<CustomerSecurityEventType, string> = {
  LOGIN_SUCCESS: 'Signed in',
  LOGIN_FAILURE_THRESHOLD: 'Sign-in temporarily blocked after failed attempts',
  PASSWORD_CHANGED: 'Password changed',
  EMAIL_CHANGED: 'Account email changed',
  RECOVERY_CODE_ROTATED: 'New recovery code generated',
  RECOVERY_CODE_ACKNOWLEDGED: 'Recovery code saved',
  PASSWORD_RECOVERED: 'Password reset with a recovery code',
  SESSION_REVOKED: 'Signed out a device',
  ALL_SESSIONS_REVOKED: 'Signed out of all devices',
  ACCOUNT_RECOVERY_GRANT_ISSUED: 'Support issued a one-time recovery credential',
  ACCOUNT_RECOVERY_GRANT_USED: 'Password reset with a support recovery credential',
  HELMET_ACTIVATED: 'Helmet activated',
  HELMET_TRANSFERRED_OUT: 'Helmet transferred to a new owner',
  HELMET_RECEIVED: 'Helmet received by transfer',
  ACCOUNT_SUSPENDED: 'Account suspended by support',
  ACCOUNT_LOCKED: 'Account locked by support',
  ACCOUNT_RESTORED: 'Account restored by support',
  ACCOUNT_DELETED: 'Account deleted',
  DATA_EXPORTED: 'Account data exported',
  DELETION_REQUESTED: 'Account deletion requested',
  DELETION_CANCELLED: 'Account deletion request cancelled',
};

/** Customer-visible account activity entry (no IP, no admin metadata). */
export interface CustomerSecurityEventDto {
  id: string;
  type: CustomerSecurityEventType;
  label: string;
  device: string | null;
  createdAt: IsoDateString;
}

export interface CustomerSecurityStatusDto {
  email: string | null;
  recoveryCodeConfigured: boolean;
  recoveryCodeAcknowledged: boolean;
  recoveryCodeCreatedAt: IsoDateString | null;
  passwordChangedAt: IsoDateString | null;
  activeSessions: number;
  lastLoginAt: IsoDateString | null;
}

// ─────────────── Dashboard health & profile completion ───────────────

export type ProfileCompletionKey =
  | 'IDENTITY'
  | 'BLOOD_GROUP'
  | 'MEDICAL_CONDITIONS'
  | 'ALLERGIES'
  | 'MEDICATIONS'
  | 'EMERGENCY_CONTACT'
  | 'PRIVACY_REVIEW'
  | 'HELMET_ENABLED';

/**
 * UX progress only. `required` items are what enabling the profile needs (plus a helmet switch to
 * share it); the percentage is never used as an authorisation or eligibility rule.
 */
export interface ProfileCompletionDto {
  percent: number;
  items: { key: ProfileCompletionKey; done: boolean; required: boolean }[];
}

export type HealthWarningCode =
  | 'NO_EMERGENCY_CONTACT'
  | 'PROFILE_INCOMPLETE'
  | 'PROFILE_DISABLED'
  | 'HELMET_SHARING_OFF'
  | 'RECOVERY_CODE_NOT_ACKNOWLEDGED'
  | 'RECOVERY_CODE_MISSING'
  | 'EMAIL_MISSING'
  | 'WARRANTY_NOT_REGISTERED'
  | 'HELMET_LOST'
  | 'HELMET_STOLEN'
  | 'HELMET_DAMAGED'
  | 'HELMET_RECALLED'
  | 'TRANSFER_PENDING'
  | 'DELETION_REQUESTED';

export type HealthSeverity = 'critical' | 'warning' | 'info';

/** A safety/account notice for the dashboard. `to` is a portal route for the fix. */
export interface HealthWarningDto {
  code: HealthWarningCode;
  severity: HealthSeverity;
  message: string;
  helmetId?: string;
  helmetCode?: string;
  action?: { label: string; to: string };
}

export interface CustomerWarrantySummaryDto {
  active: number;
  expired: number;
  notRegistered: number;
}

// ─────────────── Privacy: deletion requests & export ───────────────

export interface AccountDeletionRequestDto {
  id: string;
  status: AccountDeletionStatus;
  reason: string | null;
  requestedAt: IsoDateString;
  reviewedAt: IsoDateString | null;
  completedAt: IsoDateString | null;
  cancelledAt: IsoDateString | null;
}

/** Customer data export (JSON). Never contains hashes, tokens or other people's data. */
export interface CustomerDataExportDto {
  format: 'helmet-platform-customer-export';
  version: 1;
  exportedAt: IsoDateString;
  account: {
    customerId: string;
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    mobile: string | null;
    status: UserStatus;
    createdAt: IsoDateString;
    lastLoginAt: IsoDateString | null;
    passwordChangedAt: IsoDateString | null;
    recoveryCodeCreatedAt: IsoDateString | null;
  };
  helmets: {
    helmetCode: string;
    model: string;
    brand: string;
    status: HelmetStatus;
    emergencySharing: boolean;
  }[];
  ownershipHistory: {
    helmetCode: string;
    status: OwnershipStatus;
    acquiredVia: OwnershipAcquisition;
    from: IsoDateString;
    until: IsoDateString | null;
  }[];
  emergencyProfile: Record<string, unknown> | null;
  emergencyContacts: {
    name: string;
    relationship: string;
    phone: string;
    alternatePhone: string | null;
    priority: number;
  }[];
  privacySettings: Record<string, unknown> | null;
  warranties: {
    helmetCode: string;
    status: WarrantyStatus;
    purchaseDate: string | null;
    startDate: string | null;
    endDate: string | null;
    sellerName: string | null;
    invoiceNumber: string | null;
  }[];
  securityEvents: { type: CustomerSecurityEventType; device: string | null; at: IsoDateString }[];
  deletionRequests: AccountDeletionRequestDto[];
}

// ─────────────── Admin: customer support ───────────────

/** Admin customer views identify accounts by the public Customer ID, never the internal UUID. */
export interface AdminCustomerListItemDto {
  customerId: string;
  name: string | null;
  email: string | null;
  status: UserStatus;
  activeHelmets: number;
  createdAt: IsoDateString;
  lastLoginAt: IsoDateString | null;
}

export interface AdminCustomerSearchResponse {
  items: AdminCustomerListItemDto[];
  total: number;
  page: number;
  pageSize: number;
  /** How the query was interpreted. */
  matchedBy: 'customerId' | 'helmetId' | 'email' | 'text' | 'all';
}

/** Operational account summary. Never medical data, contacts' details, hashes or tokens. */
export interface AdminCustomerDetailDto {
  customerId: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  mobile: string | null;
  status: UserStatus;
  statusChangedAt: IsoDateString | null;
  statusReason: string | null;
  createdAt: IsoDateString;
  lastLoginAt: IsoDateString | null;
  activeSessions: number;
  helmets: {
    id: string;
    helmetCode: string;
    modelName: string;
    status: HelmetStatus;
    ownedSince: IsoDateString;
    emergencySharing: boolean;
    warrantyStatus: WarrantyStatus;
  }[];
  ownershipHistory: {
    helmetId: string;
    helmetCode: string;
    status: OwnershipStatus;
    acquiredVia: OwnershipAcquisition;
    from: IsoDateString;
    until: IsoDateString | null;
  }[];
  warrantyCount: number;
  /** Profile *state* only — the content stays encrypted and is never sent to admins. */
  emergency: { configured: boolean; enabled: boolean; contactCount: number };
  recovery: {
    recoveryCodeConfigured: boolean;
    recoveryCodeAcknowledged: boolean;
    recoveryCodeCreatedAt: IsoDateString | null;
    openGrantExpiresAt: IsoDateString | null;
    lastGrantUsedAt: IsoDateString | null;
  };
  security: {
    passwordChangedAt: IsoDateString | null;
    loginBlocks30d: number;
    lastSecurityEventAt: IsoDateString | null;
  };
  deletionRequest: AccountDeletionRequestDto | null;
}

export type AdminCustomerStatusAction = 'SUSPEND' | 'LOCK' | 'RESTORE';

export interface RecoveryGrantIssuedDto {
  customerId: string;
  /** Shown once to the SUPER_ADMIN; only a hash is stored. Never emailed automatically. */
  credential: string;
  expiresAt: IsoDateString;
}

export interface AdminPrivacyRequestDto {
  id: string;
  type: 'ACCOUNT_DELETION';
  customerId: string;
  status: AccountDeletionStatus;
  reason: string | null;
  reviewNote: string | null;
  requestedAt: IsoDateString;
  reviewedAt: IsoDateString | null;
  reviewedByName: string | null;
  completedAt: IsoDateString | null;
  cancelledAt: IsoDateString | null;
}

export interface AdminSecurityEventDto {
  id: string;
  type: CustomerSecurityEventType;
  label: string;
  customerId: string;
  device: string | null;
  createdAt: IsoDateString;
}

// ─────────────── Admin: helmet support summary ───────────────

export type HelmetHealthFlag =
  | 'NO_OWNER'
  | 'ACTIVATED'
  | 'EMERGENCY_ENABLED'
  | 'REPORTED_LOST'
  | 'REPORTED_STOLEN'
  | 'DAMAGED'
  | 'REPLACED'
  | 'RECALLED'
  | 'WARRANTY_ACTIVE'
  | 'HIGH_SCAN_ACTIVITY';

export interface HelmetScanSummaryDto {
  lastScannedAt: IsoDateString | null;
  last24h: number;
  last7d: number;
  emergency7d: number;
  verify7d: number;
}

export interface HelmetSupportSummaryDto {
  activatedAt: IsoDateString | null;
  emergencySharing: boolean;
  warrantyStatus: WarrantyStatus;
  flags: HelmetHealthFlag[];
  scans: HelmetScanSummaryDto;
}

// ─────────────── Admin: operations dashboard ───────────────

export interface OperationsDashboardDto {
  totalHelmets: number;
  activatedHelmets: number;
  unactivatedHelmets: number;
  activeEmergencyProfiles: number;
  lostOrStolen: number;
  damaged: number;
  warrantiesActive: number;
  productReportsOpen: number;
  customers: number;
  pendingPrivacyRequests: number;
  recentActivations: { helmetId: string; helmetCode: string; activatedAt: IsoDateString }[];
  /** Present only for admins allowed to view security events. */
  recentSecurityEvents?: AdminSecurityEventDto[];
}

// ─────────────── Product report triage ───────────────

export interface ProductReportEventDto {
  id: string;
  type: ProductReportEventType;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  adminName: string | null;
  createdAt: IsoDateString;
}

export const PRODUCT_REPORT_PRIORITIES: readonly ProductReportPriority[] = [
  'LOW',
  'NORMAL',
  'HIGH',
];

// ─────────────── Audit labels ───────────────

const AUDIT_LABELS: Record<string, string> = {
  'admin.login': 'Admin signed in',
  'admin.login.failed': 'Admin sign-in failed',
  'customer.created': 'Customer account created',
  'customer.login': 'Customer signed in',
  'customer.login.failed': 'Customer sign-in failed',
  'customer.login.locked': 'Customer sign-in temporarily locked',
  'customer.password.changed': 'Customer changed password',
  'customer.password.reset': 'Customer reset password',
  'customer.email.changed': 'Customer changed account email',
  'customer.recovery_code.rotated': 'Customer generated a new recovery code',
  'customer.sessions.revoked': 'Customer sessions revoked',
  'customer.status.changed': 'Customer account status changed',
  'customer.deleted': 'Customer account marked deleted',
  'customer.recovery_grant.issued': 'Account recovery grant issued',
  'customer.recovery_grant.used': 'Account recovery grant used',
  'customer.data.exported': 'Customer exported account data',
  'customer.deletion.requested': 'Account deletion requested',
  'customer.deletion.cancelled': 'Account deletion request cancelled',
  'customer.deletion.reviewed': 'Account deletion request reviewed',
  'customer.deletion.completed': 'Account deletion completed',
  'helmet.activated': 'Helmet activated',
  'helmet.status.changed': 'Helmet status changed',
  'helmet.activation.failed': 'Activation PIN incorrect',
  'helmet.activation.locked': 'Activation temporarily locked',
  'batch.created': 'Batch created',
  'batch.generated': 'Batch generated',
  'batch.printed': 'Batch marked printed',
  'export.manufacturing': 'Manufacturing export downloaded',
  'product_report.updated': 'Product report updated',
};

/** Human-readable label for an audit action; falls back to a tidied version of the key. */
export function auditActionLabel(action: string): string {
  const known = AUDIT_LABELS[action];
  if (known) return known;
  const text = action.replace(/[._]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SECRET_KEY = /pass(word)?|secret|token|hash|pin|recovery.?code|credential|cipher|email/i;

/**
 * Removes anything secret-looking from audit metadata before it leaves the API. Audit writers
 * never store secrets in the first place; this is defence in depth for the admin UI.
 */
export function redactAuditMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY.test(key)) {
      out[key] = typeof value === 'boolean' || typeof value === 'number' ? value : '[redacted]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactAuditMetadata(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ─────────────── Public emergency summary (copy / print) ───────────────

/**
 * Plain-text emergency summary built ONLY from the public DTO — which already contains nothing
 * but owner-approved fields — so a hidden field can never appear in it.
 */
export function buildEmergencySummaryText(
  dto: Pick<PublicEmergencyDto, 'profile' | 'contacts'> & { helmet?: { helmetCode?: string } },
): string {
  const p = dto.profile ?? {};
  const lines: string[] = [];
  if (p.name) lines.push(`Name: ${p.name}`);
  if (p.age !== undefined) lines.push(`Age: ${p.age}`);
  if (p.dateOfBirth) lines.push(`Date of birth: ${p.dateOfBirth}`);
  if (p.bloodGroupLabel) lines.push(`Blood Group: ${p.bloodGroupLabel}`);
  if (p.allergies?.length) lines.push(`Allergies: ${p.allergies.join(', ')}`);
  if (p.medicalConditions?.length)
    lines.push(`Medical Conditions: ${p.medicalConditions.join(', ')}`);
  if (p.medications?.length) lines.push(`Medications: ${p.medications.join(', ')}`);
  if (p.emergencyNotes) lines.push(`Notes: ${p.emergencyNotes}`);
  if (p.organDonor !== undefined) lines.push(`Organ donor: ${p.organDonor ? 'Yes' : 'No'}`);
  for (const [i, c] of (dto.contacts ?? []).entries()) {
    const alt = c.alternatePhone ? `, alt ${c.alternatePhone}` : '';
    lines.push(
      `${i === 0 ? 'Emergency Contact' : 'Secondary Contact'}: ${c.name} (${c.relationship}) ${c.phone}${alt}`,
    );
  }
  if (dto.helmet?.helmetCode) lines.push(`Helmet ID: ${dto.helmet.helmetCode}`);
  if (lines.length) lines.push('Provided by the helmet owner; not verified.');
  return lines.join('\n');
}
