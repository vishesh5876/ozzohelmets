import type { CustomerSafetyIdDto, SafetyIdStatus } from '@helmet/types';

type Tone = 'solid' | 'soft' | 'outline' | 'muted' | 'danger' | 'success';

export const SAFETY_ID_STATUS: Record<SafetyIdStatus, { label: string; tone: Tone }> = {
  GENERATED: { label: 'Not printed yet', tone: 'muted' },
  PRINTED: { label: 'Not activated', tone: 'muted' },
  ACTIVATED: { label: 'Activated', tone: 'soft' },
  ACTIVE: { label: 'Active', tone: 'solid' },
  DEACTIVATED: { label: 'Deactivated', tone: 'danger' },
  REPLACED: { label: 'Replaced', tone: 'muted' },
};

/** A Safety ID whose sharing can be switched on now (in use; a linked helmet in normal use). */
export function canShare(s: CustomerSafetyIdDto): boolean {
  return (
    (s.status === 'ACTIVATED' || s.status === 'ACTIVE') &&
    (!s.linkedHelmet || ['ACTIVATED', 'ACTIVE'].includes(s.linkedHelmet.status))
  );
}

/** Plain-language sharing line used on cards, the detail page and the dashboard. */
export function sharingLine(s: CustomerSafetyIdDto): string {
  if (s.emergencySharing) return 'Emergency Sharing: On';
  if (!canShare(s)) return 'Emergency Sharing: Not available';
  return 'Emergency Sharing: Not enabled yet';
}
