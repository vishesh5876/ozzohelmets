import { type HelmetStatus, PublicHelmetState } from '@helmet/types';

export interface OwnerContext {
  hasOwner: boolean;
  /** True when the owner's profile is enabled, meets the minimum requirements and may be shown. */
  profilePublishable: boolean;
}

/** Statuses where an owner's enabled emergency profile is shown. Recalled/damaged helmets keep
 *  emergency access: a rider wearing one still needs first responders to see their profile. */
const PROFILE_STATUSES: readonly HelmetStatus[] = ['ACTIVE', 'DAMAGED', 'RECALLED'];

/** Maps the internal lifecycle onto what the unauthenticated QR page may reveal. */
export function toPublicState(status: HelmetStatus, owner: OwnerContext): PublicHelmetState {
  switch (status) {
    case 'GENERATED':
    case 'PRINTED':
    case 'IN_INVENTORY':
    case 'SOLD':
      return PublicHelmetState.NOT_ACTIVATED;
    case 'LOST':
      return PublicHelmetState.LOST;
    case 'STOLEN':
      return PublicHelmetState.STOLEN;
    case 'REPLACED':
    case 'DEACTIVATED':
      return PublicHelmetState.UNAVAILABLE;
    case 'ACTIVATED':
    case 'ACTIVE':
    case 'DAMAGED':
    case 'RECALLED':
      if (!owner.hasOwner) return PublicHelmetState.UNAVAILABLE;
      return PROFILE_STATUSES.includes(status) && owner.profilePublishable
        ? PublicHelmetState.ACTIVE
        : PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE;
  }
}

export const PUBLIC_STATE_MESSAGES: Record<PublicHelmetState, string> = {
  NOT_ACTIVATED: 'This helmet has not yet been activated.',
  ACTIVATED_PROFILE_INCOMPLETE:
    'This helmet is registered, but its owner has not shared emergency information.',
  ACTIVE: 'Emergency information was provided by the helmet owner.',
  LOST: 'This helmet has been reported lost.',
  STOLEN: 'This helmet has been reported stolen.',
  UNAVAILABLE: 'This helmet is no longer in service.',
};
