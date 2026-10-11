import {
  ErrorCode,
  HELMET_STATUSES,
  type HelmetStatus,
  SafetyIdStatus,
  type SafetyIdStatus as SafetyIdStatusT,
} from '@helmet/types';
import type { AppConfigService } from '../../../config/app-config.service';
import {
  ActivationPolicy,
  type ActivationSnapshot,
  evaluateActivation,
  evaluateLink,
  lockoutAfterFailure,
} from './activation-policy';

const now = new Date('2026-10-03T10:00:00Z');
const fresh = (status: SafetyIdStatusT): ActivationSnapshot => ({
  status,
  activationPinUsed: false,
  hasActiveOwner: false,
  activationLockedUntil: null,
});
const policy = () =>
  new ActivationPolicy({
    get: (k: string) =>
      ({
        ACTIVATION_FAILURES_BEFORE_LOCK: 5,
        ACTIVATION_LOCKOUT_BASE_SECONDS: 900,
      })[k],
  } as unknown as AppConfigService);

describe('Safety ID activation eligibility', () => {
  it('allows PRINTED only (PIN possession is the proof; GENERATED = not printed yet)', () => {
    const p = policy();
    const allowed = Object.values(SafetyIdStatus).filter((s) => p.evaluate(fresh(s), now) === null);
    expect([...allowed].sort()).toEqual(['PRINTED']);
  });

  it.each<SafetyIdStatusT>(['GENERATED', 'DEACTIVATED', 'REPLACED'])(
    'rejects %s as not activatable',
    (s) => {
      expect(policy().evaluate(fresh(s), now)?.code).toBe(ErrorCode.SAFETY_ID_NOT_ACTIVATABLE);
    },
  );

  it('rejects double activation (used PIN or post-activation status)', () => {
    expect(
      evaluateActivation({ ...fresh('PRINTED'), activationPinUsed: true }, ['PRINTED'], now)?.code,
    ).toBe(ErrorCode.SAFETY_ID_ALREADY_ACTIVATED);
    for (const s of ['ACTIVATED', 'ACTIVE'] as const)
      expect(evaluateActivation(fresh(s), ['PRINTED'], now)?.code).toBe(
        ErrorCode.SAFETY_ID_ALREADY_ACTIVATED,
      );
  });

  it('rejects a Safety ID that already has an active owner', () => {
    expect(
      evaluateActivation({ ...fresh('PRINTED'), hasActiveOwner: true }, ['PRINTED'], now)?.code,
    ).toBe(ErrorCode.SAFETY_ID_HAS_OWNER);
  });

  it('respects an active lockout and reports retryAfter', () => {
    const denial = evaluateActivation(
      { ...fresh('PRINTED'), activationLockedUntil: new Date(now.getTime() + 60_000) },
      ['PRINTED'],
      now,
    );
    expect(denial).toMatchObject({
      code: ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED,
      details: { retryAfter: 60 },
    });
  });
});

describe('linked helmet rule (checked after the PIN)', () => {
  it('standalone Safety IDs have no helmet rule', () => {
    expect(evaluateLink({ helmet: null, actingUserId: null })).toBeNull();
  });

  it('an unowned helmet must still be activatable (it becomes the same customer’s)', () => {
    const ok = HELMET_STATUSES.filter(
      (s) => evaluateLink({ helmet: { status: s, ownerId: null }, actingUserId: 'u1' }) === null,
    );
    expect([...ok].sort()).toEqual(['IN_INVENTORY', 'PRINTED', 'SOLD']);
  });

  it('a helmet owned by someone else blocks activation (no split ownership)', () => {
    const helmet = { status: 'ACTIVATED' as HelmetStatus, ownerId: 'other' };
    expect(evaluateLink({ helmet, actingUserId: 'u1' })?.code).toBe(
      ErrorCode.SAFETY_ID_LINK_CONFLICT,
    );
    expect(evaluateLink({ helmet, actingUserId: null })?.code).toBe(
      ErrorCode.SAFETY_ID_LINK_CONFLICT,
    );
    expect(evaluateLink({ helmet: { ...helmet, ownerId: 'u1' }, actingUserId: 'u1' })).toBeNull();
  });
});

describe('progressive lockout', () => {
  it('locks every N failures with doubling duration, capped at 24h', () => {
    expect(lockoutAfterFailure(4, 5, 900, now)).toBeNull();
    expect(lockoutAfterFailure(5, 5, 900, now)?.getTime()).toBe(now.getTime() + 900_000);
    expect(lockoutAfterFailure(10, 5, 900, now)?.getTime()).toBe(now.getTime() + 1_800_000);
    expect(lockoutAfterFailure(100, 5, 900, now)?.getTime()).toBe(now.getTime() + 86_400_000);
  });
});
