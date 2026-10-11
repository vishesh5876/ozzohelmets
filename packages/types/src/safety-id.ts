/**
 * Phase 9: the Emergency Safety ID, the QR identity that carries a person's emergency
 * information. It may be linked to one helmet (a product) or exist on its own.
 */
import { HELMET_CODE_RANDOM_LENGTH, helmetCodeCheckSymbol } from './identifiers';
import type { HelmetStatus, WarrantyStatus } from './enums';
type IsoDateString = string;

export const SAFETY_CODE_PREFIX = 'SI';
export const SAFETY_CODE_REGEX =
  /^SI-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

/** Formats 8 raw symbols as `SI-XXXX-XXXX`. */
export function formatSafetyCode(symbols: string): string {
  return `${SAFETY_CODE_PREFIX}-${symbols.slice(0, 4)}-${symbols.slice(4, 8)}`;
}

/** Canonical `SI-XXXX-XXXX` from input (case, spaces and dashes ignored); prefix required. */
export function normalizeSafetyCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!compact.startsWith(SAFETY_CODE_PREFIX)) return null;
  const body = compact.slice(SAFETY_CODE_PREFIX.length);
  if (body.length !== HELMET_CODE_RANDOM_LENGTH + 1) return null;
  const formatted = formatSafetyCode(body);
  return SAFETY_CODE_REGEX.test(formatted) ? formatted : null;
}

/** Shape AND check symbol (same mod-31 check as Helmet IDs; it covers the body only). */
export function isValidSafetyCode(code: string): boolean {
  if (!SAFETY_CODE_REGEX.test(code)) return false;
  const symbols = code.slice(3).replace('-', '');
  return (
    helmetCodeCheckSymbol(symbols.slice(0, HELMET_CODE_RANDOM_LENGTH)) ===
    symbols.charAt(HELMET_CODE_RANDOM_LENGTH)
  );
}

export const SafetyIdStatus = {
  GENERATED: 'GENERATED',
  PRINTED: 'PRINTED',
  ACTIVATED: 'ACTIVATED',
  ACTIVE: 'ACTIVE',
  DEACTIVATED: 'DEACTIVATED',
  REPLACED: 'REPLACED',
} as const;
export type SafetyIdStatus = (typeof SafetyIdStatus)[keyof typeof SafetyIdStatus];

/**
 * Statuses from which a customer may activate with the Activation PIN. GENERATED is excluded
 * (labels not confirmed printed, PIN still in escrow), exactly like Phase 8 helmets.
 */
export const SAFETY_ID_ACTIVATABLE: readonly SafetyIdStatus[] = ['PRINTED'];

/** Owned and in use: emergency sharing may be switched on or off. */
export const SAFETY_ID_IN_USE: readonly SafetyIdStatus[] = ['ACTIVATED', 'ACTIVE'];

/**
 * Allowed Safety ID status transitions. ACTIVATED ↔ ACTIVE follows the owner's sharing switch;
 * DEACTIVATED is an admin decision that can be undone; REPLACED is terminal. Physical lifecycle
 * (lost, stolen, damaged, recalled) belongs to a linked helmet, never to the Safety ID.
 */
export const SAFETY_ID_TRANSITIONS: Readonly<Record<SafetyIdStatus, readonly SafetyIdStatus[]>> = {
  GENERATED: ['PRINTED', 'DEACTIVATED'],
  PRINTED: ['ACTIVATED', 'DEACTIVATED'],
  ACTIVATED: ['ACTIVE', 'DEACTIVATED', 'REPLACED'],
  ACTIVE: ['ACTIVATED', 'DEACTIVATED', 'REPLACED'],
  DEACTIVATED: ['ACTIVATED', 'PRINTED'],
  REPLACED: [],
};

export function canTransitionSafetyId(from: SafetyIdStatus, to: SafetyIdStatus): boolean {
  return SAFETY_ID_TRANSITIONS[from].includes(to);
}

export const SafetyIdBatchMode = {
  STANDALONE: 'STANDALONE',
  HELMET_LINKED: 'HELMET_LINKED',
} as const;
export type SafetyIdBatchMode = (typeof SafetyIdBatchMode)[keyof typeof SafetyIdBatchMode];

export type SafetyIdOwnershipSource = 'ACTIVATION' | 'TRANSFER' | 'ADMIN_ASSIGNMENT' | 'MIGRATION';

/**
 * Operator-facing Activation PIN state (same meanings as the Phase 8 helmet PIN state):
 * AVAILABLE = plaintext in escrow, never exported · EXPORTED = in escrow, exported for printing ·
 * PURGED = unused but plaintext destroyed · CONSUMED = used to activate.
 */
export type SafetyIdPinState = 'AVAILABLE' | 'EXPORTED' | 'PURGED' | 'CONSUMED';

/** The helmet a Safety ID is linked to, as shown next to the Safety ID (never on the emergency page). */
export interface LinkedHelmetSummaryDto {
  id: string;
  helmetCode: string;
  modelName: string;
  brand: string;
  status: HelmetStatus;
}

// ─────────────── Customer ───────────────

export interface CustomerSafetyIdDto {
  id: string;
  safetyCode: string;
  status: SafetyIdStatus;
  /** Whether THIS Safety ID exposes the owner's emergency profile. */
  emergencySharing: boolean;
  /** /e/<token> URL printed in the QR (the owner may open or print it). */
  publicUrl: string;
  activatedAt: IsoDateString | null;
  ownedSince: IsoDateString;
  linkedHelmet: LinkedHelmetSummaryDto | null;
  lastScanAt: IsoDateString | null;
  /** Standalone Safety IDs can be transferred with a Transfer Code; linked ones move with the helmet. */
  canTransfer: boolean;
  pendingTransfer: { expiresAt: IsoDateString } | null;
}

export interface CustomerSafetyIdDetailDto extends CustomerSafetyIdDto {
  scanSummary: { last30Days: number; lastEmergencyScanAt: IsoDateString | null };
  /** Linked helmet warranty, only when linked (standalone Safety IDs have none). */
  linkedWarranty: { status: WarrantyStatus; endDate: string | null } | null;
}

export interface SafetyIdTransferStartResponse {
  transferCode: string;
  expiresAt: IsoDateString;
}

export interface ClaimSafetyIdRequest {
  safetyCode: string;
  transferCode: string;
}

// ─────────────── Admin ───────────────

export interface AdminSafetyIdListItemDto {
  id: string;
  safetyCode: string;
  status: SafetyIdStatus;
  emergencySharing: boolean;
  qrIntegrityStatus: 'NORMAL' | 'UNDER_REVIEW' | 'COMPROMISED';
  owner: { customerId: string } | null;
  linkedHelmet: { id: string; helmetCode: string } | null;
  batch: { id: string; batchCode: string } | null;
  activatedAt: IsoDateString | null;
  createdAt: IsoDateString;
}

export interface AdminSafetyIdDetailDto extends AdminSafetyIdListItemDto {
  qrUrl: string;
  pinState: SafetyIdPinState;
  batchLastExportedAt: IsoDateString | null;
  scanCount: number;
  lastScanAt: IsoDateString | null;
  qrIntegrityNote: string | null;
  linkedHelmetDetail: LinkedHelmetSummaryDto | null;
  linkHistory: {
    helmetCode: string;
    startedAt: IsoDateString;
    endedAt: IsoDateString | null;
    reason: string;
  }[];
  ownershipHistory: {
    customerId: string;
    status: 'ACTIVE' | 'TRANSFERRED' | 'REVOKED';
    source: SafetyIdOwnershipSource;
    startedAt: IsoDateString;
    endedAt: IsoDateString | null;
  }[];
}

export interface SafetyIdBatchStatsDto {
  generated: number;
  printed: number;
  activated: number;
  active: number;
  remaining: number;
}

export interface SafetyIdBatchDto {
  id: string;
  batchCode: string;
  mode: SafetyIdBatchMode;
  helmetBatch: { id: string; batchCode: string } | null;
  quantity: number;
  generatedCount: number;
  generationStatus: 'PENDING' | 'GENERATING' | 'COMPLETED' | 'FAILED';
  generationError: string | null;
  generationStartedAt: IsoDateString | null;
  generationCompletedAt: IsoDateString | null;
  printStatus: 'NOT_PRINTED' | 'PRINTED';
  printedAt: IsoDateString | null;
  pinsEscrowed: number;
  exportCount: number;
  lastExportedAt: IsoDateString | null;
  notes: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: IsoDateString;
  stats?: SafetyIdBatchStatsDto;
}

export interface CreateSafetyIdBatchRequest {
  mode: SafetyIdBatchMode;
  /** STANDALONE only. */
  quantity?: number;
  /** HELMET_LINKED only: one Safety ID for every helmet of this batch that has none yet. */
  helmetBatchId?: string;
  notes?: string;
}

/** Columns of the manufacturing export (CSV and print sheet). */
export const SAFETY_ID_EXPORT_COLUMNS = [
  'safetyCode',
  'qrUrl',
  'activationPin',
  'linkedHelmetCode',
  'linkedHelmetSerial',
  'model',
  'batchCode',
] as const;
