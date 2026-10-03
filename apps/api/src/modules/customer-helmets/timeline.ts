import type {
  HelmetStatus,
  HelmetTimelineEntryDto,
  HelmetTimelineEventType,
  OwnershipAcquisition,
} from '@helmet/types';

export interface HistoryRow {
  fromStatus: HelmetStatus | null;
  toStatus: HelmetStatus;
  reasonCode: string | null;
  createdAt: Date;
}

const PRE_OWNERSHIP: readonly (HelmetStatus | null)[] = [
  null,
  'GENERATED',
  'PRINTED',
  'IN_INVENTORY',
  'SOLD',
];

const BY_CODE: Record<string, HelmetTimelineEventType> = {
  EMERGENCY_ENABLED: 'EMERGENCY_ENABLED',
  EMERGENCY_DISABLED: 'EMERGENCY_DISABLED',
  LOST_REPORTED: 'REPORTED_LOST',
  FOUND: 'FOUND',
  STOLEN_REPORTED: 'REPORTED_STOLEN',
  RECOVERED: 'RECOVERED',
  RETIRED_BY_OWNER: 'RETIRED',
  DEACTIVATED_BY_SUPPORT: 'RETIRED',
  RESTORED_BY_SUPPORT: 'RESTORED_BY_SUPPORT',
};

const DAMAGE_LABELS: Record<string, string> = {
  ACCIDENT: 'Accident',
  IMPACT: 'Impact',
  CRACKED: 'Cracked',
  OTHER: 'Other',
};

/**
 * Owner-facing timeline. Starts at THIS owner's ownership (previous owners' events are never
 * shown) and exposes only event types and safe labels — no admin names or free text.
 */
export function buildTimeline(
  ownership: { activatedAt: Date; acquiredVia: OwnershipAcquisition },
  history: HistoryRow[],
  startStatus: HelmetStatus,
): HelmetTimelineEntryDto[] {
  const start: HelmetTimelineEntryDto = {
    type: ownership.acquiredVia === 'TRANSFER' ? 'RECEIVED_BY_TRANSFER' : 'ACTIVATED',
    status: startStatus,
    at: ownership.activatedAt.toISOString(),
    detail: null,
  };
  const events = history
    .filter(
      (h) =>
        h.createdAt.getTime() >= ownership.activatedAt.getTime() &&
        h.reasonCode !== 'TRANSFERRED' &&
        !(h.toStatus === 'ACTIVATED' && PRE_OWNERSHIP.includes(h.fromStatus)),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((h) => toEntry(h));
  return [start, ...events];
}

function toEntry(h: HistoryRow): HelmetTimelineEntryDto {
  const base = { status: h.toStatus, at: h.createdAt.toISOString(), detail: null };
  const code = h.reasonCode ?? '';
  if (BY_CODE[code]) return { ...base, type: BY_CODE[code] };
  if (code.startsWith('DAMAGED')) {
    const reason = code.split(':')[1];
    return { ...base, type: 'MARKED_DAMAGED', detail: (reason && DAMAGE_LABELS[reason]) ?? null };
  }
  if (code.startsWith('REPLACED')) return { ...base, type: 'REPLACED' };
  // Rows written before reason codes existed (Phase 2) — infer from the edge.
  if (h.fromStatus === 'ACTIVATED' && h.toStatus === 'ACTIVE')
    return { ...base, type: 'EMERGENCY_ENABLED' };
  if (h.fromStatus === 'ACTIVE' && h.toStatus === 'ACTIVATED')
    return { ...base, type: 'EMERGENCY_DISABLED' };
  const byStatus: Partial<Record<HelmetStatus, HelmetTimelineEventType>> = {
    LOST: 'REPORTED_LOST',
    STOLEN: 'REPORTED_STOLEN',
    DAMAGED: 'MARKED_DAMAGED',
    DEACTIVATED: 'RETIRED',
    REPLACED: 'REPLACED',
  };
  return { ...base, type: byStatus[h.toStatus] ?? 'STATUS_CHANGED' };
}
