import type { PurchaseChannel, WarrantyStatus } from '@helmet/types';
import type { BadgeProps } from '@helmet/ui';

export const WARRANTY_LABEL: Record<
  WarrantyStatus,
  { label: string; tone: NonNullable<BadgeProps['tone']> }
> = {
  NOT_REGISTERED: { label: 'Not registered', tone: 'outline' },
  ACTIVE: { label: 'Warranty active', tone: 'solid' },
  EXPIRED: { label: 'Warranty expired', tone: 'muted' },
  VOID: { label: 'Warranty void', tone: 'muted' },
  REPLACED: { label: 'Moved to replacement', tone: 'soft' },
  CANCELLED: { label: 'Warranty cancelled', tone: 'muted' },
};

export const CHANNEL_LABEL: Record<PurchaseChannel, string> = {
  BRAND_WEBSITE: 'Brand website',
  DEALER: 'Dealer',
  MARKETPLACE: 'Online marketplace',
  RETAIL_STORE: 'Retail store',
  OTHER: 'Other',
};

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

/** Formats a YYYY-MM-DD calendar date without time-zone drift. */
export function formatDay(day: string | null): string {
  return day ? dateFmt.format(new Date(`${day}T00:00:00Z`)) : '—';
}

/** One-line summary shown on cards. */
export function warrantyLine(w: { status: WarrantyStatus; endDate: string | null }): string {
  switch (w.status) {
    case 'ACTIVE':
      return `Warranty active until ${formatDay(w.endDate)}`;
    case 'EXPIRED':
      return `Warranty expired on ${formatDay(w.endDate)}`;
    case 'REPLACED':
      return 'Warranty moved to the replacement helmet';
    case 'NOT_REGISTERED':
      return 'Warranty not registered';
    default:
      return WARRANTY_LABEL[w.status].label;
  }
}
