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
  ProductReportReason,
  ProductReportStatus,
  PublicHelmetState,
  PublicProductVerificationState,
  PurchaseChannel,
  ReplacementReason,
  TransferStatus,
  WarrantyCorrectionReason,
  WarrantyEvent,
  WarrantyRegistrationSource,
  WarrantyStatus,
  WarrantyVoidReason,
} from './enums';
import type { HelmetListGroup, OwnerHelmetAction } from './lifecycle';
import type {
  CustomerSecurityEventDto,
  CustomerSecurityStatusDto,
  CustomerWarrantySummaryDto,
  HealthWarningDto,
  HelmetSupportSummaryDto,
  ProductReportEventDto,
  ProfileCompletionDto,
} from './support';
import type { ProductReportPriority } from './enums';
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
  /** Warranty policy for helmets of this model (months; admin-controlled). */
  warrantyEnabled: boolean;
  warrantyMonths: number;
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
  /** Public Customer ID (`CU-…`) for support cross-reference — never the internal UUID. */
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
  /** Phase 5: operational summary (no medical content). */
  support: HelmetSupportSummaryDto;
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
  /** Phase 5: readable label, actor type and the customer's public Customer ID when known. */
  label: string;
  actorType: 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  customerId: string | null;
  /** Secret-looking keys are redacted server-side. */
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
  /**
   * Present in ACTIVE — and, since Phase 4, in DAMAGED/RECALLED when this helmet was already
   * sharing — with only the fields the owner made visible.
   */
  profile?: PublicEmergencyProfileDto | null;
  contacts?: PublicEmergencyContactDto[];
  /** Lifecycle warning shown alongside the profile (e.g. damaged, recall). */
  warning?: string;
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
  /** Permanent public Customer ID (`CU-XXXX-XXXX`) — usable with the password to sign in. */
  customerId: string;
  name: string | null;
  /**
   * Account email: the normal sign-in identifier (unique, bound at first activation). NOT
   * verified and never proof of helmet possession — the Activation PIN is. Null only for
   * accounts created before email sign-in existed.
   */
  email: string | null;
  /** Always false today: there is no email verification (no OTP, no links). */
  emailVerified: boolean;
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
  /** Safe session id (the refresh-token family id) — never a token or token hash. */
  id: string;
  /** Coarse "Browser on OS" summary; nothing more is stored. */
  device: string | null;
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
  /** Effective warranty status and last covered day (Phase 4). */
  warranty: { status: WarrantyStatus; endDate: string | null };
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
  /** Phase 5 */
  completion: ProfileCompletionDto;
  health: HealthWarningDto[];
  security: CustomerSecurityStatusDto;
  warranty: CustomerWarrantySummaryDto;
  recentActivity: CustomerSecurityEventDto[];
}

// ─────────────── Phase 4: warranty ───────────────

/** Coverage facts — safe for any current owner (and, reduced, for the public page). */
export interface WarrantySummaryDto {
  status: WarrantyStatus;
  source: WarrantyRegistrationSource | null;
  registeredAt: IsoDateString | null;
  /** Calendar dates (YYYY-MM-DD). `endDate` is the last covered day. */
  purchaseDate: string | null;
  startDate: string | null;
  endDate: string | null;
}

/** Private purchase details: only for the registrant while they own the helmet. */
export interface WarrantyPrivateDetailsDto {
  purchaseChannel: PurchaseChannel | null;
  sellerName: string | null;
  sellerCity: string | null;
  invoiceNumber: string | null;
  notes: string | null;
  hasProof: boolean;
  proofUploadedAt: IsoDateString | null;
}

export interface CustomerWarrantyDto extends WarrantySummaryDto {
  /** Model policy (what registering would give). */
  policy: { enabled: boolean; months: number };
  canRegister: boolean;
  /** Null for later owners after a transfer (previous owner's details stay private). */
  details: WarrantyPrivateDetailsDto | null;
  replacedByHelmetCode: string | null;
  replacesHelmetCode: string | null;
}

export interface RegisterWarrantyRequest {
  purchaseDate: string;
  purchaseChannel?: PurchaseChannel;
  sellerName?: string;
  sellerCity?: string;
  invoiceNumber?: string;
  notes?: string;
}

export interface WarrantyHistoryDto {
  id: string;
  event: WarrantyEvent;
  fromStatus: WarrantyStatus | null;
  toStatus: WarrantyStatus;
  actorType: string;
  actorName: string | null;
  reasonCode: string | null;
  note: string | null;
  changes: Record<string, unknown> | null;
  createdAt: IsoDateString;
}

export interface AdminWarrantyListItemDto extends WarrantySummaryDto {
  id: string;
  helmet: { id: string; helmetCode: string; serialNumber: string; modelName: string };
  /** Current owner's public Customer ID (null when ownerless). */
  ownerCustomerId: string | null;
  invoiceNumber: string | null;
}

export interface AdminWarrantyDetailDto extends AdminWarrantyListItemDto {
  registeredByCustomerId: string | null;
  purchaseChannel: PurchaseChannel | null;
  sellerName: string | null;
  sellerCity: string | null;
  notes: string | null;
  hasProof: boolean;
  proofContentType: string | null;
  proofUploadedAt: IsoDateString | null;
  voidReason: WarrantyVoidReason | null;
  voidedAt: IsoDateString | null;
  replacementOf: { helmetCode: string } | null;
  replacedBy: { helmetCode: string } | null;
  history: WarrantyHistoryDto[];
}

export interface CorrectWarrantyRequest {
  purchaseDate?: string;
  startDate?: string;
  endDate?: string;
  purchaseChannel?: PurchaseChannel | null;
  sellerName?: string | null;
  invoiceNumber?: string | null;
  reasonCode: WarrantyCorrectionReason;
  note?: string;
}

// ─────────────── Phase 4: product authenticity & reports ───────────────

export interface PublicProductVerificationDto {
  state: PublicProductVerificationState;
  /** One concise explanation of what this verification means (or why it failed). */
  message: string;
  product?: {
    helmetCode: string;
    modelName: string;
    brand: string;
    sku: string;
    /** YYYY-MM */
    manufactured: string;
    batchRef: string;
  };
  lifecycle?: { label: string; warning: string | null };
  activated?: boolean;
  warranty?: { status: WarrantyStatus; endsOn: string | null };
  recallWarning?: string;
  /**
   * Phase 6: present only when an admin marked this QR as compromised — a neutral prompt to check
   * the Helmet ID on the inner label (never "counterfeit").
   */
  integrityNotice?: string;
}

export interface CreateProductReportRequest {
  publicToken?: string;
  helmetCode?: string;
  reason: ProductReportReason;
  description?: string;
  contactEmail?: string;
}

export interface ProductReportDto {
  id: string;
  reason: ProductReportReason;
  description: string | null;
  contactEmail: string | null;
  status: ProductReportStatus;
  helmet: { id: string; helmetCode: string } | null;
  resolutionNote: string | null;
  reviewedByName: string | null;
  /** Phase 5 triage */
  priority: ProductReportPriority;
  assignee: { id: string; name: string } | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export interface ProductReportDetailDto extends ProductReportDto {
  events: ProductReportEventDto[];
}
