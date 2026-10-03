import type { EmergencyProfileStatus } from '@helmet/types';
import type { BadgeProps } from '@helmet/ui';

export const PROFILE_LABEL: Record<
  EmergencyProfileStatus,
  { label: string; tone: NonNullable<BadgeProps['tone']> }
> = {
  NOT_CONFIGURED: { label: 'Profile not set up', tone: 'outline' },
  INCOMPLETE: { label: 'Profile incomplete', tone: 'soft' },
  DISABLED: { label: 'Profile off', tone: 'muted' },
  ACTIVE: { label: 'Profile active', tone: 'solid' },
};
