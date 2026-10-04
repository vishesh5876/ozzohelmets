import { ErrorCode, HELMET_STATUSES, type HelmetStatus } from '@helmet/types';
import type { AppConfigService } from '../../../config/app-config.service';
import {
  ActivationPolicy,
  type ActivationSnapshot,
  evaluateActivation,
  lockoutAfterFailure,
} from './activation-policy';

const now = new Date('2026-10-03T10:00:00Z');
const fresh = (status: HelmetStatus): ActivationSnapshot => ({
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

describe('activation eligibility', () => {
  it('allows PRINTED, IN_INVENTORY and SOLD (PIN possession is the purchase proof)', () => {
    const p = policy();
    const allowed = HELMET_STATUSES.filter((s) => p.evaluate(fresh(s), now) === null);
    expect([...allowed].sort()).toEqual(['IN_INVENTORY', 'PRINTED', 'SOLD']);
  });

  it.each<HelmetStatus>(['GENERATED', 'DAMAGED', 'REPLACED', 'DEACTIVATED', 'RECALLED'])(
    'rejects %s as not activatable',
    (status) => {
      expect(policy().evaluate(fresh(status), now)?.code).toBe(ErrorCode.HELMET_NOT_ACTIVATABLE);
    },
  );

  it('rejects double activation (used PIN or post-activation status) as HELMET_ALREADY_ACTIVATED', () => {
    expect(
      evaluateActivation({ ...fresh('SOLD'), activationPinUsed: true }, ['SOLD'], now)?.code,
    ).toBe(ErrorCode.HELMET_ALREADY_ACTIVATED);
    for (const s of ['ACTIVATED', 'ACTIVE', 'LOST', 'STOLEN'] as const) {
      expect(evaluateActivation(fresh(s), ['SOLD'], now)?.code).toBe(
        ErrorCode.HELMET_ALREADY_ACTIVATED,
      );
    }
  });

  it('rejects a helmet that already has an active owner', () => {
    expect(
      evaluateActivation({ ...fresh('SOLD'), hasActiveOwner: true }, ['SOLD'], now)?.code,
    ).toBe(ErrorCode.HELMET_HAS_OWNER);
  });

  it('respects an active lockout and reports retryAfter', () => {
    const denial = evaluateActivation(
      { ...fresh('SOLD'), activationLockedUntil: new Date(now.getTime() + 60_000) },
      ['SOLD'],
      now,
    );
    expect(denial).toMatchObject({
      code: ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED,
      details: { retryAfter: 60 },
    });
    expect(
      evaluateActivation(
        { ...fresh('SOLD'), activationLockedUntil: new Date(now.getTime() - 1) },
        ['SOLD'],
        now,
      ),
    ).toBeNull();
  });
});

describe('progressive lockout', () => {
  it('locks every N failures with doubling duration, capped at 24h', () => {
    expect(lockoutAfterFailure(4, 5, 900, now)).toBeNull();
    expect(lockoutAfterFailure(5, 5, 900, now)?.getTime()).toBe(now.getTime() + 900_000);
    expect(lockoutAfterFailure(10, 5, 900, now)?.getTime()).toBe(now.getTime() + 1_800_000);
    expect(lockoutAfterFailure(15, 5, 900, now)?.getTime()).toBe(now.getTime() + 3_600_000);
    expect(lockoutAfterFailure(100, 5, 900, now)?.getTime()).toBe(now.getTime() + 86_400_000);
  });
});
