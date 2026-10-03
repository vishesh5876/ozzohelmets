import {
  type EmergencyProfileStatus,
  type EmergencyReadinessDto,
  ReadinessRequirement,
} from '@helmet/types';

export interface ReadinessFacts {
  ownsHelmet: boolean;
  hasProfile: boolean;
  name: string | null;
  activeContactCount: number;
  privacyConfirmed: boolean;
  enabled: boolean;
}

/**
 * Minimum information before a customer may enable their emergency profile (and helmets may
 * become ACTIVE). Blood group is deliberately optional — many people don't know theirs.
 */
export function missingRequirements(f: ReadinessFacts): ReadinessRequirement[] {
  const missing: ReadinessRequirement[] = [];
  if (!f.name || f.name.trim().length === 0) missing.push(ReadinessRequirement.NAME);
  if (f.activeContactCount < 1) missing.push(ReadinessRequirement.EMERGENCY_CONTACT);
  if (!f.privacyConfirmed) missing.push(ReadinessRequirement.PRIVACY_REVIEW);
  return missing;
}

export function profileStatus(f: ReadinessFacts): EmergencyProfileStatus {
  if (!f.hasProfile) return 'NOT_CONFIGURED';
  if (f.enabled) return 'ACTIVE';
  return missingRequirements(f).length > 0 ? 'INCOMPLETE' : 'DISABLED';
}

/** Owner-facing summary. The percentage is a UX hint only — never an authorisation input. */
export function evaluateReadiness(f: ReadinessFacts): EmergencyReadinessDto {
  const missing = missingRequirements(f);
  const steps: EmergencyReadinessDto['steps'] = [
    { key: 'ACTIVATED', done: f.ownsHelmet },
    { key: 'DETAILS', done: !missing.includes(ReadinessRequirement.NAME) },
    { key: 'CONTACTS', done: !missing.includes(ReadinessRequirement.EMERGENCY_CONTACT) },
    { key: 'PRIVACY', done: !missing.includes(ReadinessRequirement.PRIVACY_REVIEW) },
    { key: 'ENABLED', done: f.enabled },
  ];
  return {
    status: profileStatus(f),
    enabled: f.enabled,
    canEnable: missing.length === 0,
    missing,
    completionPercent: steps.filter((s) => s.done).length * 20,
    steps,
  };
}

/**
 * Status shown for one helmet. The account profile may be enabled while THIS helmet's switch is
 * off (e.g. a second or transferred-in helmet) — that helmet reports DISABLED.
 */
export function helmetProfileStatus(
  owner: EmergencyProfileStatus,
  helmetEnabled: boolean,
): EmergencyProfileStatus {
  if (owner === 'ACTIVE' && !helmetEnabled) return 'DISABLED';
  return owner;
}
