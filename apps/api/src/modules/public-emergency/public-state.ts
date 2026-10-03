import { type HelmetStatus, PublicHelmetState } from '@helmet/types';

/**
 * Maps the internal lifecycle status onto what the unauthenticated QR page may reveal.
 * Product-side states (damaged, recalled) never hide emergency information for an owned helmet:
 * a rider wearing a recalled helmet still needs first responders to see their profile.
 */
export function toPublicState(status: HelmetStatus, hasOwner: boolean): PublicHelmetState {
  switch (status) {
    case 'GENERATED':
    case 'PRINTED':
    case 'IN_INVENTORY':
    case 'SOLD':
      return PublicHelmetState.NOT_ACTIVATED;
    case 'ACTIVATED':
      return PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE;
    case 'ACTIVE':
      return PublicHelmetState.ACTIVE;
    case 'LOST':
      return PublicHelmetState.LOST;
    case 'STOLEN':
      return PublicHelmetState.STOLEN;
    case 'DAMAGED':
    case 'RECALLED':
      return hasOwner ? PublicHelmetState.ACTIVE : PublicHelmetState.UNAVAILABLE;
    case 'REPLACED':
    case 'DEACTIVATED':
      return PublicHelmetState.UNAVAILABLE;
  }
}

export const PUBLIC_STATE_MESSAGES: Record<PublicHelmetState, string> = {
  NOT_ACTIVATED: 'This helmet has not yet been activated.',
  ACTIVATED_PROFILE_INCOMPLETE:
    'This helmet is registered, but its owner has not set up emergency information yet.',
  ACTIVE: 'This helmet is registered. Emergency information is not available yet.',
  LOST: 'This helmet has been reported lost by its owner.',
  STOLEN: 'This helmet has been reported stolen.',
  UNAVAILABLE: 'This helmet is no longer in service.',
};
