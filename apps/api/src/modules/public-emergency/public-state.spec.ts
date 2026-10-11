import { HELMET_STATUSES, PublicHelmetState, SafetyIdStatus } from '@helmet/types';
import { mayShowProfile, PUBLIC_STATE_MESSAGES, toPublicState } from './public-state';

const owned = { hasOwner: true, profilePublishable: true };
const ownedHidden = { hasOwner: true, profilePublishable: false };
const unowned = { hasOwner: false, profilePublishable: false };

describe('toPublicState (Phase 9: Safety ID first, then linked helmet)', () => {
  it('shows an unactivated Safety ID as NOT_ACTIVATED, linked or not', () => {
    for (const s of ['GENERATED', 'PRINTED'] as const) {
      expect(toPublicState(s, null, unowned).state).toBe(PublicHelmetState.NOT_ACTIVATED);
      expect(toPublicState(s, 'PRINTED', unowned).state).toBe(PublicHelmetState.NOT_ACTIVATED);
      expect(toPublicState(s, 'SOLD', unowned).state).toBe(PublicHelmetState.NOT_ACTIVATED);
    }
    expect(PUBLIC_STATE_MESSAGES.NOT_ACTIVATED).toBe('This Safety ID has not been activated yet.');
  });

  it('standalone: shows a profile only when ACTIVE with a publishable profile', () => {
    expect(toPublicState('ACTIVE', null, owned)).toMatchObject({
      state: PublicHelmetState.ACTIVE,
      showProfile: true,
    });
    expect(toPublicState('ACTIVE', null, ownedHidden).state).toBe(
      PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE,
    );
    expect(toPublicState('ACTIVATED', null, owned).state).toBe(
      PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE,
    );
    expect(toPublicState('ACTIVE', null, unowned).state).toBe(PublicHelmetState.UNAVAILABLE);
  });

  it('Safety ID deactivated or replaced wins over everything', () => {
    expect(toPublicState('DEACTIVATED', 'ACTIVE', owned)).toMatchObject({
      state: PublicHelmetState.DEACTIVATED,
      showProfile: false,
      message: 'This Safety ID is no longer active.',
    });
    expect(toPublicState('REPLACED', null, owned).state).toBe(PublicHelmetState.REPLACED);
  });

  it('linked helmet lost/stolen/replaced/deactivated hides the profile (Phase 4 rule kept)', () => {
    const expected = {
      LOST: PublicHelmetState.LOST,
      STOLEN: PublicHelmetState.STOLEN,
      REPLACED: PublicHelmetState.REPLACED,
      DEACTIVATED: PublicHelmetState.DEACTIVATED,
    } as const;
    for (const [helmet, state] of Object.entries(expected)) {
      const d = toPublicState('ACTIVE', helmet as keyof typeof expected, owned);
      expect(d.state).toBe(state);
      expect(d.showProfile).toBe(false);
    }
    expect(toPublicState('ACTIVATED', 'LOST', owned).message).toBe(
      'The helmet carrying this Safety ID has been reported lost.',
    );
  });

  it('an unactivated linked helmet that was retired or recalled keeps its Phase 8 state', () => {
    expect(toPublicState('PRINTED', 'DEACTIVATED', unowned).state).toBe(
      PublicHelmetState.DEACTIVATED,
    );
    expect(toPublicState('PRINTED', 'RECALLED', unowned).state).toBe(PublicHelmetState.RECALLED);
    expect(toPublicState('GENERATED', 'DAMAGED', unowned).state).toBe(PublicHelmetState.DAMAGED);
  });

  it('linked helmet damaged/recalled still shows a sharing profile with a warning', () => {
    const d = toPublicState('ACTIVE', 'DAMAGED', owned);
    expect(d).toMatchObject({ state: PublicHelmetState.DAMAGED, showProfile: true });
    expect(d.warning).toBe('This helmet is marked as damaged.');
    expect(toPublicState('ACTIVE', 'RECALLED', owned).warning).toMatch(/recall/);
    expect(toPublicState('ACTIVATED', 'DAMAGED', owned).showProfile).toBe(false);
    expect(toPublicState('ACTIVE', 'RECALLED', ownedHidden).showProfile).toBe(false);
  });

  it('only an ACTIVE Safety ID can carry a profile, for every helmet status', () => {
    for (const s of Object.values(SafetyIdStatus))
      for (const h of [null, ...HELMET_STATUSES]) {
        const d = toPublicState(s, h, owned);
        expect(Object.values(PublicHelmetState)).toContain(d.state);
        if (s !== 'ACTIVE') expect(d.showProfile).toBe(false);
        if (d.showProfile) expect(mayShowProfile(s, true, h)).toBe(true);
      }
  });
});
