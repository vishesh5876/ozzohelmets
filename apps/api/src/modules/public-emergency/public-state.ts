import { type HelmetStatus, PublicHelmetState } from '@helmet/types';

export interface OwnerContext {
  hasOwner: boolean;
  /**
   * True when this helmet's per-helmet switch is on and the owner's profile is enabled, meets the
   * minimum requirements and may be shown.
   */
  profilePublishable: boolean;
}

/**
 * The ONLY status in which emergency information may be returned. Every other state is an
 * explicit, data-free message (Phase 3: lost/stolen/damaged/replaced/deactivated/recalled never
 * expose medical data or contacts).
 */
export const PROFILE_VISIBLE_STATUS: HelmetStatus = 'ACTIVE';

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
    case 'DAMAGED':
      return PublicHelmetState.DAMAGED;
    case 'REPLACED':
      return PublicHelmetState.REPLACED;
    case 'DEACTIVATED':
      return PublicHelmetState.DEACTIVATED;
    case 'RECALLED':
      return PublicHelmetState.RECALLED;
    case 'ACTIVATED':
    case 'ACTIVE':
      // e.g. ownership revoked by support: no owner, nothing to show.
      if (!owner.hasOwner) return PublicHelmetState.UNAVAILABLE;
      return status === PROFILE_VISIBLE_STATUS && owner.profilePublishable
        ? PublicHelmetState.ACTIVE
        : PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE;
  }
}

export const PUBLIC_STATE_MESSAGES: Record<PublicHelmetState, string> = {
  NOT_ACTIVATED: 'This helmet has not yet been activated.',
  ACTIVATED_PROFILE_INCOMPLETE:
    'This helmet is registered, but its owner has not shared emergency information.',
  ACTIVE:
    'Emergency information and contacts were provided by the helmet owner and are not verified.',
  LOST: 'This helmet has been reported lost.',
  STOLEN: 'This helmet has been reported stolen.',
  DAMAGED: 'This helmet is currently marked as damaged.',
  REPLACED: 'This helmet has been replaced and is no longer active.',
  DEACTIVATED: 'This helmet is no longer active.',
  RECALLED: 'This helmet is subject to a manufacturer recall.',
  UNAVAILABLE: 'This helmet is not currently in service.',
};
