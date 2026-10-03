import { HELMET_STATUSES, PublicHelmetState } from '@helmet/types';
import { PUBLIC_STATE_MESSAGES, toPublicState } from './public-state';

const owned = { hasOwner: true, profilePublishable: true };
const ownedHidden = { hasOwner: true, profilePublishable: false };
const unowned = { hasOwner: false, profilePublishable: false };

describe('toPublicState', () => {
  it('shows unactivated inventory as NOT_ACTIVATED', () => {
    for (const s of ['GENERATED', 'PRINTED', 'IN_INVENTORY', 'SOLD'] as const)
      expect(toPublicState(s, unowned)).toBe(PublicHelmetState.NOT_ACTIVATED);
    expect(PUBLIC_STATE_MESSAGES.NOT_ACTIVATED).toBe('This helmet has not yet been activated.');
  });

  it('shows a profile only for ACTIVE helmets with a publishable owner profile', () => {
    expect(toPublicState('ACTIVE', owned)).toBe(PublicHelmetState.ACTIVE);
    expect(toPublicState('ACTIVE', ownedHidden)).toBe(
      PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE,
    );
    expect(toPublicState('ACTIVATED', owned)).toBe(PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE);
    expect(toPublicState('ACTIVE', unowned)).toBe(PublicHelmetState.UNAVAILABLE);
  });

  it('never exposes a profile in any non-active lifecycle state (Phase 3)', () => {
    const expected = {
      LOST: PublicHelmetState.LOST,
      STOLEN: PublicHelmetState.STOLEN,
      DAMAGED: PublicHelmetState.DAMAGED,
      REPLACED: PublicHelmetState.REPLACED,
      DEACTIVATED: PublicHelmetState.DEACTIVATED,
      RECALLED: PublicHelmetState.RECALLED,
    } as const;
    for (const [status, state] of Object.entries(expected)) {
      expect(toPublicState(status as keyof typeof expected, owned)).toBe(state);
    }
    expect(PUBLIC_STATE_MESSAGES.STOLEN).toBe('This helmet has been reported stolen.');
    expect(PUBLIC_STATE_MESSAGES.LOST).toBe('This helmet has been reported lost.');
    expect(PUBLIC_STATE_MESSAGES.DAMAGED).toBe('This helmet is currently marked as damaged.');
    expect(PUBLIC_STATE_MESSAGES.REPLACED).toBe(
      'This helmet has been replaced and is no longer active.',
    );
    expect(PUBLIC_STATE_MESSAGES.DEACTIVATED).toBe('This helmet is no longer active.');
  });

  it('maps every status, and only ACTIVE can carry a profile', () => {
    for (const s of HELMET_STATUSES) {
      const state = toPublicState(s, owned);
      expect(Object.values(PublicHelmetState)).toContain(state);
      if (s !== 'ACTIVE') expect(state).not.toBe(PublicHelmetState.ACTIVE);
    }
  });
});
