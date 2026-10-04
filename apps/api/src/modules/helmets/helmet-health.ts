import type { HelmetHealthFlag, HelmetStatus, WarrantyStatus } from '@helmet/types';

export interface HelmetHealthFacts {
  status: HelmetStatus;
  hasOwner: boolean;
  activated: boolean;
  emergencySharing: boolean;
  warrantyStatus: WarrantyStatus;
  scans24h: number;
  highScanThreshold24h: number;
}

/** Operational summary flags for support. Not a counterfeit score — just facts at a glance. */
export function helmetHealthFlags(f: HelmetHealthFacts): HelmetHealthFlag[] {
  const flags: HelmetHealthFlag[] = [];
  if (!f.hasOwner) flags.push('NO_OWNER');
  if (f.activated) flags.push('ACTIVATED');
  if (f.emergencySharing && f.status === 'ACTIVE') flags.push('EMERGENCY_ENABLED');
  if (f.status === 'LOST') flags.push('REPORTED_LOST');
  if (f.status === 'STOLEN') flags.push('REPORTED_STOLEN');
  if (f.status === 'DAMAGED') flags.push('DAMAGED');
  if (f.status === 'REPLACED') flags.push('REPLACED');
  if (f.status === 'RECALLED') flags.push('RECALLED');
  if (f.warrantyStatus === 'ACTIVE') flags.push('WARRANTY_ACTIVE');
  if (f.scans24h >= f.highScanThreshold24h) flags.push('HIGH_SCAN_ACTIVITY');
  return flags;
}
