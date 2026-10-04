import type {
  CustomerHelmetDto,
  CustomerSecurityStatusDto,
  EmergencyReadinessDto,
  HealthWarningDto,
  ProfileCompletionDto,
  ProfileCompletionKey,
} from '@helmet/types';

/** Helmet statuses where emergency sharing / warranty prompts make sense (owned, in service). */
const IN_SERVICE = ['ACTIVATED', 'ACTIVE'] as const;
const WARRANTY_PROMPT = ['ACTIVATED', 'ACTIVE', 'LOST', 'STOLEN', 'DAMAGED', 'RECALLED'] as const;

export interface CompletionFacts {
  name: string | null;
  bloodGroup: string | null;
  hasMedicalConditions: boolean;
  hasAllergies: boolean;
  hasMedications: boolean;
  activeContactCount: number;
  privacyConfirmed: boolean;
  /** Profile enabled AND at least one helmet's switch on. */
  sharingOnAnyHelmet: boolean;
}

/**
 * Emergency-profile completion as a UX percentage over 8 components. `required` marks what
 * enabling needs; eligibility itself is decided by `missingRequirements` (readiness.ts), never by
 * this percentage.
 */
export function evaluateCompletion(f: CompletionFacts): ProfileCompletionDto {
  const items: { key: ProfileCompletionKey; done: boolean; required: boolean }[] = [
    { key: 'IDENTITY', done: !!f.name?.trim(), required: true },
    { key: 'BLOOD_GROUP', done: !!f.bloodGroup, required: false },
    { key: 'MEDICAL_CONDITIONS', done: f.hasMedicalConditions, required: false },
    { key: 'ALLERGIES', done: f.hasAllergies, required: false },
    { key: 'MEDICATIONS', done: f.hasMedications, required: false },
    { key: 'EMERGENCY_CONTACT', done: f.activeContactCount > 0, required: true },
    { key: 'PRIVACY_REVIEW', done: f.privacyConfirmed, required: true },
    { key: 'HELMET_ENABLED', done: f.sharingOnAnyHelmet, required: true },
  ];
  return {
    percent: Math.round((items.filter((i) => i.done).length / items.length) * 100),
    items,
  };
}

export interface HealthInput {
  helmets: CustomerHelmetDto[];
  readiness: EmergencyReadinessDto;
  contactCount: number;
  security: CustomerSecurityStatusDto;
  deletionRequested: boolean;
}

/**
 * Safety and account notices for the dashboard, most severe first. A utility — no upsell, and
 * nothing that depends on unverified data being "verified".
 */
export function evaluateHealth(input: HealthInput): HealthWarningDto[] {
  const out: HealthWarningDto[] = [];
  const { helmets, readiness, security } = input;
  const owned = helmets.length > 0;

  for (const h of helmets) {
    const at = { helmetId: h.id, helmetCode: h.helmetCode };
    const view = { label: 'View helmet', to: `/app/helmets/${h.id}` };
    if (h.status === 'STOLEN')
      out.push({
        code: 'HELMET_STOLEN',
        severity: 'critical',
        message: `${h.helmetCode} is reported stolen.`,
        ...at,
        action: view,
      });
    if (h.status === 'LOST')
      out.push({
        code: 'HELMET_LOST',
        severity: 'critical',
        message: `${h.helmetCode} is reported lost.`,
        ...at,
        action: view,
      });
    if (h.status === 'RECALLED')
      out.push({
        code: 'HELMET_RECALLED',
        severity: 'critical',
        message: `${h.helmetCode} is subject to a manufacturer recall. Do not continue to ride with it.`,
        ...at,
        action: view,
      });
    if (h.status === 'DAMAGED')
      out.push({
        code: 'HELMET_DAMAGED',
        severity: 'warning',
        message: `${h.helmetCode} is marked as damaged.`,
        ...at,
        action: view,
      });
    if (h.pendingTransfer)
      out.push({
        code: 'TRANSFER_PENDING',
        severity: 'info',
        message: `A transfer of ${h.helmetCode} is waiting to be claimed.`,
        ...at,
        action: view,
      });
  }

  if (owned && input.contactCount === 0)
    out.push({
      code: 'NO_EMERGENCY_CONTACT',
      severity: 'critical',
      message: 'No emergency contact is set up. Responders will have nobody to call.',
      action: { label: 'Add emergency contact', to: '/app/contacts' },
    });
  if (owned && !readiness.canEnable && input.contactCount > 0)
    out.push({
      code: 'PROFILE_INCOMPLETE',
      severity: 'warning',
      message: 'Your emergency profile is missing required information.',
      action: { label: 'Complete emergency profile', to: '/app/profile' },
    });
  if (owned && readiness.canEnable && !readiness.enabled)
    out.push({
      code: 'PROFILE_DISABLED',
      severity: 'warning',
      message:
        'Your emergency profile is turned off. Scanning your helmet shows no emergency information.',
      action: { label: 'Review privacy', to: '/app/privacy' },
    });
  if (readiness.enabled)
    for (const h of helmets)
      if ((IN_SERVICE as readonly string[]).includes(h.status) && !h.emergencyEnabled)
        out.push({
          code: 'HELMET_SHARING_OFF',
          severity: 'warning',
          message: `Emergency information is off on ${h.helmetCode}.`,
          helmetId: h.id,
          helmetCode: h.helmetCode,
          action: { label: 'Turn on for this helmet', to: `/app/helmets/${h.id}` },
        });

  if (!security.recoveryCodeConfigured)
    out.push({
      code: 'RECOVERY_CODE_MISSING',
      severity: 'warning',
      message: 'You have no recovery code. Generate one so you can reset a forgotten password.',
      action: { label: 'Manage account', to: '/app/account' },
    });
  else if (!security.recoveryCodeAcknowledged)
    out.push({
      code: 'RECOVERY_CODE_NOT_ACKNOWLEDGED',
      severity: 'warning',
      message:
        'You haven’t confirmed saving your recovery code. Generate a new one if you lost it.',
      action: { label: 'Manage account', to: '/app/account' },
    });
  if (!security.email)
    out.push({
      code: 'EMAIL_MISSING',
      severity: 'info',
      message: 'Add an account email so you can sign in with it.',
      action: { label: 'Add email', to: '/app/account' },
    });
  if (input.deletionRequested)
    out.push({
      code: 'DELETION_REQUESTED',
      severity: 'info',
      message: 'You have requested account deletion. You can cancel it from your account page.',
      action: { label: 'Manage account', to: '/app/account' },
    });

  for (const h of helmets)
    if (
      (WARRANTY_PROMPT as readonly string[]).includes(h.status) &&
      h.warranty.status === 'NOT_REGISTERED'
    )
      out.push({
        code: 'WARRANTY_NOT_REGISTERED',
        severity: 'info',
        message: `Warranty not registered for ${h.helmetCode}.`,
        helmetId: h.id,
        helmetCode: h.helmetCode,
        action: { label: 'Register warranty', to: `/app/helmets/${h.id}/warranty` },
      });

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
