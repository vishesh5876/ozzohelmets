import type { WarrantyStatus } from '@helmet/types';
import type { BadgeProps } from '@helmet/ui';

export const STATUS_TONE: Record<WarrantyStatus, NonNullable<BadgeProps['tone']>> = {
  NOT_REGISTERED: 'outline',
  ACTIVE: 'solid',
  EXPIRED: 'muted',
  VOID: 'danger',
  REPLACED: 'soft',
  CANCELLED: 'muted',
};

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

export function formatDay(day: string | null): string {
  return day ? fmt.format(new Date(`${day}T00:00:00Z`)) : '—';
}
