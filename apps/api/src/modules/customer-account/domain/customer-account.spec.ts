import type {
  CustomerHelmetDto,
  CustomerSecurityStatusDto,
  EmergencyReadinessDto,
} from '@helmet/types';
import { nextDeletionStatus } from './deletion-policy';
import { buildCustomerExport, type ExportSource } from './export';
import { evaluateCompletion, evaluateHealth } from './health';

const facts = {
  name: 'Asha',
  bloodGroup: null,
  hasMedicalConditions: false,
  hasAllergies: false,
  hasMedications: false,
  activeContactCount: 0,
  privacyConfirmed: false,
  sharingOnAnyHelmet: false,
};

describe('profile completion', () => {
  it('is a percentage over 8 components, separate from eligibility', () => {
    expect(evaluateCompletion(facts).percent).toBe(13);
    const full = evaluateCompletion({
      ...facts,
      bloodGroup: 'O_POSITIVE',
      hasMedicalConditions: true,
      hasAllergies: true,
      hasMedications: true,
      activeContactCount: 1,
      privacyConfirmed: true,
      sharingOnAnyHelmet: true,
    });
    expect(full.percent).toBe(100);
    expect(full.items).toHaveLength(8);
    // Required items are what enabling needs; medical details are optional.
    expect(full.items.filter((i) => i.required).map((i) => i.key)).toEqual([
      'IDENTITY',
      'EMERGENCY_CONTACT',
      'PRIVACY_REVIEW',
      'HELMET_ENABLED',
    ]);
  });

  it('a 75% profile can still be fully eligible (percentage is never the rule)', () => {
    const c = evaluateCompletion({
      ...facts,
      bloodGroup: 'A_NEGATIVE',
      activeContactCount: 2,
      privacyConfirmed: true,
      sharingOnAnyHelmet: true,
    });
    expect(c.percent).toBe(63);
    expect(c.items.filter((i) => i.required).every((i) => i.done)).toBe(true);
  });
});

const helmet = (over: Partial<CustomerHelmetDto>): CustomerHelmetDto =>
  ({
    id: 'h1',
    helmetCode: 'HM-AAAA-AAAA',
    status: 'ACTIVE',
    emergencyEnabled: true,
    pendingTransfer: null,
    warranty: { status: 'ACTIVE', endDate: null },
    ...over,
  }) as CustomerHelmetDto;
const readiness = (over: Partial<EmergencyReadinessDto> = {}) =>
  ({
    status: 'ACTIVE',
    enabled: true,
    canEnable: true,
    missing: [],
    completionPercent: 100,
    steps: [],
    ...over,
  }) as EmergencyReadinessDto;
const security: CustomerSecurityStatusDto = {
  email: 'a@example.com',
  recoveryCodeConfigured: true,
  recoveryCodeAcknowledged: true,
  recoveryCodeCreatedAt: null,
  passwordChangedAt: null,
  activeSessions: 1,
  lastLoginAt: null,
};

describe('dashboard health check', () => {
  it('flags safety problems first and stays quiet when everything is fine', () => {
    expect(
      evaluateHealth({
        helmets: [helmet({})],
        readiness: readiness(),
        contactCount: 2,
        security,
        deletionRequested: false,
      }),
    ).toEqual([]);
    const warnings = evaluateHealth({
      helmets: [
        helmet({
          id: 'a',
          helmetCode: 'HM-1',
          status: 'STOLEN',
          warranty: { status: 'NOT_REGISTERED', endDate: null },
        }),
        helmet({ id: 'b', helmetCode: 'HM-2', emergencyEnabled: false }),
      ],
      readiness: readiness(),
      contactCount: 0,
      security: { ...security, recoveryCodeAcknowledged: false, email: null },
      deletionRequested: true,
    });
    const codes = warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'HELMET_STOLEN',
        'NO_EMERGENCY_CONTACT',
        'HELMET_SHARING_OFF',
        'RECOVERY_CODE_NOT_ACKNOWLEDGED',
        'EMAIL_MISSING',
        'DELETION_REQUESTED',
        'WARRANTY_NOT_REGISTERED',
      ]),
    );
    expect(warnings[0]!.severity).toBe('critical');
    expect(warnings.at(-1)!.severity).toBe('info');
  });

  it('reports a disabled profile and missing recovery code', () => {
    const codes = evaluateHealth({
      helmets: [helmet({ status: 'ACTIVATED', emergencyEnabled: false })],
      readiness: readiness({ enabled: false }),
      contactCount: 1,
      security: { ...security, recoveryCodeConfigured: false },
      deletionRequested: false,
    }).map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['PROFILE_DISABLED', 'RECOVERY_CODE_MISSING']));
    expect(codes).not.toContain('HELMET_SHARING_OFF');
  });
});

describe('deletion request state machine', () => {
  it('allows only the documented transitions', () => {
    expect(nextDeletionStatus('REQUESTED', 'APPROVE')).toBe('APPROVED');
    expect(nextDeletionStatus('REQUESTED', 'REJECT')).toBe('REJECTED');
    expect(nextDeletionStatus('REQUESTED', 'CANCEL')).toBe('CANCELLED');
    expect(nextDeletionStatus('REQUESTED', 'COMPLETE')).toBeNull();
    expect(nextDeletionStatus('APPROVED', 'COMPLETE')).toBe('COMPLETED');
    expect(nextDeletionStatus('APPROVED', 'CANCEL')).toBe('CANCELLED');
    for (const terminal of ['REJECTED', 'COMPLETED', 'CANCELLED'] as const)
      for (const a of ['APPROVE', 'REJECT', 'COMPLETE', 'CANCEL'] as const)
        expect(nextDeletionStatus(terminal, a)).toBeNull();
  });
});

describe('customer data export sanitizer', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  const source = {
    user: {
      customerCode: 'CU-AAAA-AAAQ',
      name: 'Asha',
      email: 'a@example.com',
      emailVerified: false,
      mobile: null,
      status: 'ACTIVE',
      createdAt: now,
      lastLoginAt: null,
      passwordChangedAt: now,
      recoveryCodeCreatedAt: now,
      // Columns that must never be exported, even if the caller passes the whole row:
      passwordHash: '$argon2id$secret',
      recoveryCodeHash: '$argon2id$recovery',
      id: '0192-internal-uuid',
    },
    helmets: [],
    ownerships: [],
    profile: null,
    contacts: [],
    visibility: { showName: true, id: 'vis-id', userId: 'user-id', confirmedAt: now },
    warranties: [
      {
        helmetCode: 'HM-1',
        status: 'ACTIVE',
        purchaseDate: now,
        startDate: now,
        endDate: now,
        isRegistrant: false,
        sellerName: 'Previous owner shop',
        invoiceNumber: 'INV-PREV',
      },
    ],
    events: [],
    deletionRequests: [],
  } as unknown as ExportSource;

  it('copies only allow-listed fields: no hashes, internal ids or previous owners’ details', () => {
    const json = JSON.stringify(buildCustomerExport(source, now));
    for (const leak of [
      'argon2id',
      '0192-internal-uuid',
      'vis-id',
      'user-id',
      'Previous owner shop',
      'INV-PREV',
    ])
      expect(json).not.toContain(leak);
    const out = buildCustomerExport(source, now);
    expect(out.account.customerId).toBe('CU-AAAA-AAAQ');
    expect(out.privacySettings).toEqual({ showName: true, confirmedAt: now.toISOString() });
    expect(out.warranties[0]).toMatchObject({ sellerName: null, invoiceNumber: null });
  });
});
