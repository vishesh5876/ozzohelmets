/**
 * Phase 6 contracts: analytics aggregates, explainable risk signals and alerts, customer scan
 * summary. Nothing here carries medical data, IP hashes or user agents.
 */
import type {
  DeviceCategory,
  HelmetStatus,
  ProductReportReason,
  ProductReportStatus,
  QrIntegrityStatus,
  RiskAlertStatus,
  RiskAlertType,
  RiskLevel,
  RiskSignalType,
  ScanType,
  WarrantyStatus,
} from './enums';

type IsoDateString = string;
/** `YYYY-MM-DD` (UTC). */
type DateOnly = string;

export interface CursorPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

export type AnalyticsRangeKey = 'today' | '7d' | '30d' | 'custom';

export interface PlatformDailyPointDto {
  date: DateOnly;
  helmetsGenerated: number;
  helmetsActivated: number;
  newCustomers: number;
  emergencyScans: number;
  verificationScans: number;
  warrantiesRegistered: number;
  productReportsCreated: number;
  riskAlertsOpened: number;
  invalidTokenRequests: number;
}

export interface AnalyticsOverviewDto {
  range: { from: DateOnly; to: DateOnly };
  /** Current state (not range-bound). */
  current: {
    helmetsGenerated: number;
    helmetsActivated: number;
    /** activated / generated, 0–1. */
    activationRate: number;
    activeEmergencyProfiles: number;
    /** Helmets sharing emergency information / activated helmets, 0–1. */
    emergencySharingRate: number;
    profilesCreated: number;
    profilesEnabled: number;
    profilesIncomplete: number;
    ownedHelmetsWithoutContacts: number;
    warrantiesActive: number;
    warrantiesExpired: number;
    /** Activated helmets with a registered warranty, 0–1. */
    warrantyRegistrationRate: number;
    /** Registered warranties with a proof of purchase, 0–1. */
    proofUploadRate: number;
    openProductReports: number;
    openRiskAlerts: number;
    /** Average days from batch "printed" to activation (activated helmets), or null. */
    avgDaysPrintedToActivation: number | null;
  };
  /** Totals within the range. */
  period: {
    helmetsGenerated: number;
    helmetsActivated: number;
    newCustomers: number;
    emergencyScans: number;
    verificationScans: number;
    warrantiesRegistered: number;
    productReportsCreated: number;
    riskAlertsOpened: number;
  };
  series: PlatformDailyPointDto[];
  warrantyByModel: { model: string; sku: string; activated: number; registered: number; active: number }[];
  recentActivations: { helmetId: string; helmetCode: string; activatedAt: IsoDateString }[];
}

export interface ScanCountsDto {
  total: number;
  emergency: number;
  verify: number;
}

export interface ScanAnalyticsDto {
  range: { from: DateOnly; to: DateOnly };
  today: ScanCountsDto;
  last7d: ScanCountsDto;
  last30d: ScanCountsDto;
  period: ScanCountsDto;
  uniqueHelmetsScannedInPeriod: number;
  helmetsWithUnusualActivity: number;
  invalidTokenRequestsInPeriod: number;
  topHelmets: {
    helmetId: string;
    helmetCode: string;
    model: string;
    scans: number;
    emergency: number;
    verify: number;
    riskLevel: RiskLevel;
  }[];
  series: { date: DateOnly; total: number; emergency: number; verify: number }[];
}

export interface HelmetActivityItemDto {
  helmetId: string;
  helmetCode: string;
  model: string;
  status: HelmetStatus;
  qrIntegrityStatus: QrIntegrityStatus;
  scans24h: number;
  scans7d: number;
  riskLevel: RiskLevel;
  riskScore: number;
  lastScanAt: IsoDateString | null;
  openAlerts: number;
}

export interface RiskReasonDto {
  type: RiskSignalType;
  label: string;
  observed: number;
  threshold: number;
  weight: number;
  detail: string;
}

export interface RiskSignalDto {
  id: string;
  type: RiskSignalType;
  label: string;
  severity: RiskLevel;
  status: 'ACTIVE' | 'CLEARED';
  observedValue: number;
  thresholdValue: number;
  windowStart: IsoDateString;
  windowEnd: IsoDateString;
  firstDetectedAt: IsoDateString;
  lastDetectedAt: IsoDateString;
  clearedAt: IsoDateString | null;
}

export interface RiskAlertDto {
  id: string;
  type: RiskAlertType;
  label: string;
  status: RiskAlertStatus;
  priority: RiskLevel;
  helmet: { id: string; helmetCode: string } | null;
  /** Opaque source reference for source-level alerts (not an IP or IP hash). */
  sourceRef: string | null;
  summary: string;
  reasons: RiskReasonDto[];
  observedValue: number | null;
  thresholdValue: number | null;
  occurrences: number;
  firstSeenAt: IsoDateString;
  lastSeenAt: IsoDateString;
  assignee: { id: string; name: string } | null;
  resolutionReason: string | null;
  resolvedAt: IsoDateString | null;
  resolvedByName: string | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export interface HelmetRiskDto {
  level: RiskLevel;
  score: number;
  reasons: RiskReasonDto[];
  evaluatedAt: IsoDateString;
  firstDetectedAt: IsoDateString | null;
  lastDetectedAt: IsoDateString | null;
  resolvedAt: IsoDateString | null;
  resolutionReason: string | null;
}

export interface HelmetAnalyticsDetailDto {
  helmet: {
    id: string;
    helmetCode: string;
    model: string;
    sku: string;
    status: HelmetStatus;
    activatedAt: IsoDateString | null;
    emergencySharing: boolean;
    warrantyStatus: WarrantyStatus;
    qrIntegrityStatus: QrIntegrityStatus;
    qrIntegrityNote: string | null;
    qrIntegrityChangedAt: IsoDateString | null;
  };
  totals: {
    scans24h: number;
    scans30d: number;
    emergency30d: number;
    verify30d: number;
    /** Sum of daily distinct IP hashes over 7 days (over-counts repeat visitors across days). */
    approxUniqueVisitors7d: number;
    lastScanAt: IsoDateString | null;
  };
  series: { date: DateOnly; total: number; emergency: number; verify: number; uniqueVisitors: number }[];
  risk: HelmetRiskDto | null;
  signals: RiskSignalDto[];
  /** Only for admins with `risk-alert:view`. */
  alerts?: RiskAlertDto[];
  productReports: {
    total: number;
    last30d: number;
    recent: { id: string; reason: ProductReportReason; status: ProductReportStatus; createdAt: IsoDateString }[];
  };
  /** Human-readable correlation note, e.g. reports + suspicious scans → "Review recommended". */
  correlation: string | null;
}

export interface HelmetScanEventDto {
  id: string;
  scanType: ScanType;
  scannedAt: IsoDateString;
  deviceCategory: DeviceCategory | null;
  cacheHit: boolean | null;
}

/** Owner-facing, neutral: counts since this owner's ownership began, max 30 days back. */
export interface CustomerScanSummaryDto {
  since: IsoDateString;
  lastEmergencyScanAt: IsoDateString | null;
  emergencyScans30d: number;
  verificationScans30d: number;
  message: string;
}

export const RISK_SIGNAL_LABELS: Record<RiskSignalType, string> = {
  HIGH_SCAN_VOLUME: 'High scan volume',
  HIGH_UNIQUE_VISITOR_COUNT: 'Many distinct visitors',
  RAPID_IP_CHURN: 'Rapid visitor churn',
  ABNORMAL_VERIFY_ACTIVITY: 'Unusual verification activity',
  PRODUCT_REPORT_CORRELATION: 'Product reports on this helmet',
  QR_SHARED_OR_COPIED_POSSIBLE: 'Possible copied or shared QR',
};

export const RISK_ALERT_LABELS: Record<RiskAlertType, string> = {
  HELMET_SCAN_ANOMALY: 'Unusual QR activity',
  HIGH_PUBLIC_SCAN_VOLUME: 'High public scan volume',
  TOKEN_ENUMERATION: 'Possible token enumeration',
  VALID_TOKEN_SCRAPING: 'Possible scraping of valid helmets',
  SYSTEM_RATE_LIMIT_SPIKE: 'Spike in unknown-code requests',
};

/** Statement shown wherever risk is displayed. */
export const RISK_DISCLAIMER =
  'Suspicious scan activity does not prove a physical helmet is counterfeit. Review recommended.';
