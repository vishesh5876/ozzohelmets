import type {
  ActorType,
  AdminRole,
  AdminUserStatus,
  BatchGenerationStatus,
  BatchPrintStatus,
  HelmetModelStatus,
  HelmetStatus,
  PublicHelmetState,
} from './enums';
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

export interface HelmetDetailDto extends HelmetListItemDto {
  qrUrl: string;
  activationPinUsed: boolean;
  pinEscrowed: boolean;
  scanCount: number;
  allowedTransitions: HelmetStatus[];
  statusHistory: HelmetStatusHistoryDto[];
  updatedAt: IsoDateString;
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
  helmet: { modelName: string; brand: string };
  message: string;
  /** Present only once Phase 2 emergency profiles exist and visibility allows. */
  profile?: null;
}
