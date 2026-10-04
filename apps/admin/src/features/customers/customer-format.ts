import type { BadgeProps } from '@helmet/ui';
import type { UserStatus } from '@helmet/types';

export const STATUS_TONE: Record<UserStatus, NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'solid',
  SUSPENDED: 'danger',
  LOCKED: 'danger',
  DELETED: 'muted',
};
