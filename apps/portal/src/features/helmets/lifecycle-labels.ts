import type { HelmetListGroup, HelmetTimelineEventType, OwnerHelmetAction } from '@helmet/types';

/** Page-based owner actions (emergency on/off is handled inline). */
export type ActionSlug =
  'transfer' | 'lost' | 'found' | 'stolen' | 'recovered' | 'damaged' | 'retire';

export const ACTION_PAGES: Partial<Record<OwnerHelmetAction, { slug: ActionSlug; label: string }>> =
  {
    TRANSFER: { slug: 'transfer', label: 'Transfer' },
    REPORT_LOST: { slug: 'lost', label: 'Report lost' },
    MARK_FOUND: { slug: 'found', label: 'Mark as found' },
    REPORT_STOLEN: { slug: 'stolen', label: 'Report stolen' },
    MARK_RECOVERED: { slug: 'recovered', label: 'Mark as recovered' },
    MARK_DAMAGED: { slug: 'damaged', label: 'Mark damaged' },
    RETIRE: { slug: 'retire', label: 'Retire helmet' },
  };

export const GROUP_TITLES: Record<HelmetListGroup, string> = {
  ACTIVE: 'Active',
  NEEDS_ATTENTION: 'Needs attention',
  RETIRED: 'Retired',
};

export const TIMELINE_LABELS: Record<HelmetTimelineEventType, string> = {
  ACTIVATED: 'Activated',
  RECEIVED_BY_TRANSFER: 'Received by transfer',
  EMERGENCY_ENABLED: 'Emergency information turned on',
  EMERGENCY_DISABLED: 'Emergency information turned off',
  REPORTED_LOST: 'Reported lost',
  FOUND: 'Found',
  REPORTED_STOLEN: 'Reported stolen',
  RECOVERED: 'Recovered',
  MARKED_DAMAGED: 'Marked damaged',
  RETIRED: 'Retired',
  REPLACED: 'Replaced',
  RESTORED_BY_SUPPORT: 'Restored by support',
  STATUS_CHANGED: 'Status changed',
};
