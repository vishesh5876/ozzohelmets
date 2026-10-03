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
 * Statuses in which approved emergency information may be returned (Phase 4 rule):
 * - ACTIVE: the current owner's switch is on;
 * - DAMAGED / RECALLED: only if this helmet was already sharing (switch on) and the owner's
 *   profile is still enabled — a damaged helmet may be scanned right after the accident that
 *   damaged it. A lifecycle warning is always shown alongside.
 * LOST, STOLEN, REPLACED, DEACTIVATED never return emergency information.
 */
export const PROFILE_VISIBLE_STATUSES: readonly HelmetStatus[] = ['ACTIVE', 'DAMAGED', 'RECALLED'];

/** Warning shown together with a profile on a damaged or recalled helmet. */
export const LIFECYCLE_WARNINGS: Partial<Record<HelmetStatus, string>> = {
  DAMAGED: 'This helmet is marked as damaged.',
  RECALLED: 'This helmet is subject to a manufacturer recall. Do not continue to ride with it.',
};

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
    // DAMAGED / RECALLED keep their state; the service attaches the profile when allowed.
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
      return status === 'ACTIVE' && owner.profilePublishable
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
