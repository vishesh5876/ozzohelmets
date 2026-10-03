import { HELMET_STATUSES, PublicHelmetState } from '@helmet/types';
import { PUBLIC_STATE_MESSAGES, toPublicState } from './public-state';

describe('toPublicState', () => {
  it('shows unactivated inventory as NOT_ACTIVATED', () => {
    for (const s of ['GENERATED', 'PRINTED', 'IN_INVENTORY', 'SOLD'] as const) {
      expect(toPublicState(s, false)).toBe(PublicHelmetState.NOT_ACTIVATED);
    }
    expect(PUBLIC_STATE_MESSAGES.NOT_ACTIVATED).toBe('This helmet has not yet been activated.');
  });

  it('keeps emergency access for owned helmets that are damaged or recalled', () => {
    expect(toPublicState('RECALLED', true)).toBe(PublicHelmetState.ACTIVE);
    expect(toPublicState('DAMAGED', true)).toBe(PublicHelmetState.ACTIVE);
    expect(toPublicState('RECALLED', false)).toBe(PublicHelmetState.UNAVAILABLE);
  });

  it('maps every status', () => {
    for (const s of HELMET_STATUSES)
      expect(Object.values(PublicHelmetState)).toContain(toPublicState(s, true));
  });
});
