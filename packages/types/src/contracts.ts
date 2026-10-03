import type {
  ActorType,
  BloodGroup,
  EmergencyProfileStatus,
  Gender,
  ReadinessRequirement,
  AdminRole,
  AdminUserStatus,
  BatchGenerationStatus,
  BatchPrintStatus,
  HelmetModelStatus,
  HelmetStatus,
  OwnershipAcquisition,
  OwnershipStatus,
  PublicHelmetState,
  ReplacementReason,
  TransferStatus,
} from './enums';
import type { HelmetListGroup, OwnerHelmetAction } from './lifecycle';
import type { Permission } from './permissions';

/** ISO-8601 timestamp string as serialised by the API. */
export type IsoDateString = string;

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  permissions: Permission[];
  lastLoginAt: IsoDateString | null;
}

export interface AdminLoginResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  admin: AdminProfile;
}

export interface AdminUserDto {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  status: AdminUserStatus;
  lastLoginAt: IsoDateString | null;
  createdAt: IsoDateString;
}

export interface HelmetModelDto {
  id: string;
  name: string;
  sku: string;
  brand: string;
  description: string | null;
  status: HelmetModelStatus;
  helmetCount: number;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export interface BatchDto {
  id: string;
  batchCode: string;
  helmetModel: { id: string; name: string; sku: string };
  manufacturingDate: IsoDateString;
  quantity: number;
  generatedCount: number;
  generationStatus: BatchGenerationStatus;
  generationError: string | null;
  generationStartedAt: IsoDateString | null;
  generationCompletedAt: IsoDateString | null;
  printStatus: BatchPrintStatus;
  printedAt: IsoDateString | null;
  pinsEscrowed: number;
  notes: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export interface HelmetListItemDto {
  id: string;
  helmetCode: string;
  serialNumber: string;
  status: HelmetStatus;
  helmetModel: { id: string; name: string; sku: string };
  batch: { id: string; batchCode: string };
  activatedAt: IsoDateString | null;
  createdAt: IsoDateString;
}

export interface HelmetStatusHistoryDto {
  id: string;
  fromStatus: HelmetStatus | null;
  toStatus: HelmetStatus;
  actorType: ActorType;
  actorName: string | null;
  reason: string | null;
  createdAt: IsoDateString;
}

/** Operational ownership summary for admins — no personal or medical data beyond a masked number. */
export interface HelmetOwnerSummaryDto {
  /** Internal customer id, for support cross-reference only. */
  customerId: string;
  /** Owner-provided, unverified contact number (masked). */
  maskedMobile: string | null;
  since: IsoDateString;
  emergencyProfileStatus: EmergencyProfileStatus;
}

export interface HelmetDetailDto extends HelmetListItemDto {
  owner: HelmetOwnerSummaryDto | null;
  qrUrl: string;
  activationPinUsed: boolean;
  pinEscrowed: boolean;
  scanCount: number;
  allowedTransitions: HelmetStatus[];
  statusHistory: HelmetStatusHistoryDto[];
  pendingTransfer: AdminPendingTransferDto | null;
  replacement: HelmetReplacementLinksDto;
  /** Target a support "restore" would apply now, or null when nothing can be restored. */
  restoreTarget: HelmetStatus | null;
  updatedAt: IsoDateString;
}

export interface AdminPendingTransferDto {
  id: string;
  createdAt: IsoDateString;
  expiresAt: IsoDateString;
}

export interface ReplacementLinkDto {
  id: string;
  helmetId: string;
  helmetCode: string;
  reason: ReplacementReason;
  notes: string | null;
  createdAt: IsoDateString;
  createdByAdminName: string | null;
}

/** `replacedBy`: the helmet that replaced this one. `replaces`: the helmet this one replaced. */
export interface HelmetReplacementLinksDto {
  replacedBy: ReplacementLinkDto | null;
  replaces: ReplacementLinkDto | null;
}

export interface OwnershipPeriodDto {
  id: string;
  customerId: string;
  maskedMobile: string | null;
  status: OwnershipStatus;
  acquiredVia: OwnershipAcquisition;
  startedAt: IsoDateString;
  endedAt: IsoDateString | null;
  endReason: string | null;
  endedByAdminName: string | null;
}

export interface TransferHistoryItemDto {
  id: string;
  status: TransferStatus;
  createdAt: IsoDateString;
  expiresAt: IsoDateString;
  claimedAt: IsoDateString | null;
  cancelledAt: IsoDateString | null;
  cancelReason: string | null;
}

export interface AdminRecentAuthResponse {
  recentAuthToken: string;
  expiresIn: number;
}

export interface AuditLogDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  admin: { id: string; name: string; email: string } | null;
  userId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: IsoDateString;
}

export interface DashboardStatsDto {
  helmetModels: number;
  batches: number;
  helmets: number;
  activatedHelmets: number;
  helmetsByStatus: Partial<Record<HelmetStatus, number>>;
  recentBatches: Pick<
    BatchDto,
    'id' | 'batchCode' | 'quantity' | 'generatedCount' | 'generationStatus' | 'createdAt'
  >[];
}

/** Public, unauthenticated QR resolution. Never contains internal identifiers. */
export interface PublicEmergencyDto {
  state: PublicHelmetState;
  /** `helmetCode` is included only while an emergency profile is shown (for identification). */
  helmet: { modelName: string; brand: string; helmetCode?: string };
  message: string;
  /** Present only in the ACTIVE state; contains only fields the owner made visible. */
  profile?: PublicEmergencyProfileDto | null;
  contacts?: PublicEmergencyContactDto[];
}

/** Every key is optional and omitted (not null) when hidden by the owner. */
export interface PublicEmergencyProfileDto {
  name?: string;
  /** Relative URL served by the API; present only when the photo is visible. */
  photoUrl?: string;
  bloodGroup?: BloodGroup;
  bloodGroupLabel?: string;
  dateOfBirth?: string;
  age?: number;
  gender?: Gender;
  allergies?: string[];
  medicalConditions?: string[];
  medications?: string[];
  emergencyNotes?: string;
  organDonor?: boolean;
}

export interface PublicEmergencyContactDto {
  name: string;
  relationship: string;
  phone: string;
  alternatePhone?: string;
}

// ─────────────────────────── Customer ───────────────────────────

export interface CustomerProfile {
  id: string;
  name: string | null;
  /** Optional, owner-provided and NOT verified — never used for authentication or recovery. */
  email: string | null;
  /** Optional, owner-provided and NOT verified — never used for authentication or recovery. */
  mobile: string | null;
  createdAt: IsoDateString;
}

export interface CustomerLoginResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  customer: CustomerProfile;
}

/** Returned once when a recovery code is created or rotated. Never retrievable again. */
export interface RecoveryCodeIssued {
  recoveryCode: string;
}

export interface CustomerRecoverResponse {
  /** Single-use, short-lived token that authorises one password reset. */
  resetToken: string;
  expiresIn: number;
}

export type CustomerResetPasswordResponse = CustomerLoginResponse & RecoveryCodeIssued;

export interface CustomerSessionDto {
  id: string;
  userAgent: string | null;
  createdAt: IsoDateString;
  lastUsedAt: IsoDateString;
  current: boolean;
}

export interface ActivationValidateResponse {
  activatable: true;
  helmet: { modelName: string; brand: string; helmetCode: string };
}

export interface CustomerHelmetDto {
  id: string;
  helmetCode: string;
  serialNumber: string;
  status: HelmetStatus;
  model: { name: string; brand: string };
  activatedAt: IsoDateString | null;
  ownedSince: IsoDateString;
  publicUrl: string;
  emergencyProfileStatus: EmergencyProfileStatus;
  /** Whether THIS helmet exposes the owner's emergency profile (per-helmet switch). */
  emergencyEnabled: boolean;
  acquiredVia: OwnershipAcquisition;
  group: HelmetListGroup;
  /** Owner actions valid in the current status (computed by the API). */
  availableActions: OwnerHelmetAction[];
  pendingTransfer: { expiresAt: IsoDateString } | null;
  replacedBy: { helmetCode: string } | null;
  replaces: { helmetCode: string } | null;
}

export type HelmetTimelineEventType =
  | 'ACTIVATED'
  | 'RECEIVED_BY_TRANSFER'
  | 'EMERGENCY_ENABLED'
  | 'EMERGENCY_DISABLED'
  | 'REPORTED_LOST'
  | 'FOUND'
  | 'REPORTED_STOLEN'
  | 'RECOVERED'
  | 'MARKED_DAMAGED'
  | 'RETIRED'
  | 'REPLACED'
  | 'RESTORED_BY_SUPPORT'
  | 'STATUS_CHANGED';

/** Owner-facing timeline: only events since THIS owner's ownership began; no admin details. */
export interface HelmetTimelineEntryDto {
  type: HelmetTimelineEventType;
  status: HelmetStatus;
  at: IsoDateString;
  detail: string | null;
}

export interface CustomerHelmetDetailDto extends CustomerHelmetDto {
  timeline: HelmetTimelineEntryDto[];
}

export interface RecentAuthResponse {
  recentAuthToken: string;
  expiresIn: number;
}

export interface TransferCreatedResponse {
  /** Shown once; only an HMAC is stored. */
  transferCode: string;
  expiresAt: IsoDateString;
}

export interface PendingTransferDto {
  pending: boolean;
  expiresAt: IsoDateString | null;
}

export interface TransferClaimPreviewResponse {
  helmet: { helmetCode: string; modelName: string; brand: string };
}

export interface TransferClaimResponse {
  helmet: CustomerHelmetDto;
}

/** New customer claiming a transfer: account created, signed in, recovery code shown once. */
export type TransferClaimRegisterResponse = CustomerLoginResponse &
  RecoveryCodeIssued & { helmet: CustomerHelmetDto };

/** First activation: account created, signed in, recovery code shown once. */
export type ActivationRegisterResponse = CustomerLoginResponse &
  RecoveryCodeIssued & { helmet: CustomerHelmetDto };

/** Existing customer adding another helmet. */
export interface ActivationAddHelmetResponse {
  helmet: CustomerHelmetDto;
}

export interface EmergencyProfileDto {
  name: string | null;
  hasPhoto: boolean;
  bloodGroup: BloodGroup | null;
  dateOfBirth: string | null;
  gender: Gender | null;
  allergies: string[];
  medicalConditions: string[];
  medications: string[];
  emergencyNotes: string | null;
  organDonor: boolean | null;
  emergencyProfileEnabled: boolean;
  updatedAt: IsoDateString | null;
}

export interface EmergencyProfileInput {
  name?: string | null;
  bloodGroup?: BloodGroup | null;
  dateOfBirth?: string | null;
  gender?: Gender | null;
  allergies?: string[];
  medicalConditions?: string[];
  medications?: string[];
  emergencyNotes?: string | null;
  organDonor?: boolean | null;
}

export interface EmergencyContactDto {
  id: string;
  name: string;
  relationship: string;
  phone: string;
  alternatePhone: string | null;
  priority: number;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export interface EmergencyVisibilityDto {
  showName: boolean;
  showPhoto: boolean;
  showBloodGroup: boolean;
  showDateOfBirth: boolean;
  showGender: boolean;
  showAllergies: boolean;
  showMedicalConditions: boolean;
  showMedications: boolean;
  showEmergencyNotes: boolean;
  showOrganDonor: boolean;
  showEmergencyContacts: boolean;
  confirmedAt: IsoDateString | null;
}

export type EmergencyVisibilityInput = Omit<EmergencyVisibilityDto, 'confirmedAt'>;

export interface EmergencyReadinessDto {
  status: EmergencyProfileStatus;
  enabled: boolean;
  canEnable: boolean;
  missing: ReadinessRequirement[];
  /** UX-only progress indicator (0–100). Never used for authorisation. */
  completionPercent: number;
  steps: { key: 'ACTIVATED' | 'DETAILS' | 'CONTACTS' | 'PRIVACY' | 'ENABLED'; done: boolean }[];
}

export interface CustomerDashboardDto {
  helmets: CustomerHelmetDto[];
  readiness: EmergencyReadinessDto;
  contactCount: number;
}
