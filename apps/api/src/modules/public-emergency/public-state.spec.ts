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
  });

  it('keeps emergency access for owned helmets that are damaged or recalled', () => {
    expect(toPublicState('RECALLED', owned)).toBe(PublicHelmetState.ACTIVE);
    expect(toPublicState('DAMAGED', owned)).toBe(PublicHelmetState.ACTIVE);
    expect(toPublicState('RECALLED', unowned)).toBe(PublicHelmetState.UNAVAILABLE);
  });

  it('never exposes a profile for lost/stolen helmets (Phase 3 decision)', () => {
    expect(toPublicState('LOST', owned)).toBe(PublicHelmetState.LOST);
    expect(toPublicState('STOLEN', owned)).toBe(PublicHelmetState.STOLEN);
    expect(PUBLIC_STATE_MESSAGES.STOLEN).toBe('This helmet has been reported stolen.');
    expect(PUBLIC_STATE_MESSAGES.LOST).toBe('This helmet has been reported lost.');
  });

  it('maps every status', () => {
    for (const s of HELMET_STATUSES)
      expect(Object.values(PublicHelmetState)).toContain(toPublicState(s, owned));
  });
});
