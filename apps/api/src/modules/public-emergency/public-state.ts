import { type HelmetStatus, PublicHelmetState, type SafetyIdStatus } from '@helmet/types';

export interface OwnerContext {
  hasOwner: boolean;
  /**
   * True when this Safety ID's sharing switch is on and the owner's profile is enabled, meets the
   * minimum requirements and may be shown.
   */
  profilePublishable: boolean;
}

/**
 * Linked-helmet statuses that never return emergency information (Phase 4 rule, kept in Phase 9
 * as a relationship rule): LOST, STOLEN, REPLACED, DEACTIVATED. DAMAGED / RECALLED still show it
 * while the Safety ID is sharing — a damaged helmet may be scanned right after the accident that
 * damaged it — with a lifecycle warning alongside.
 */
export const PROFILE_HIDDEN_HELMET_STATUSES: readonly HelmetStatus[] = [
  'LOST',
  'STOLEN',
  'REPLACED',
  'DEACTIVATED',
];

/** Warning shown together with a profile when the linked helmet is damaged or recalled. */
export const LIFECYCLE_WARNINGS: Partial<Record<HelmetStatus, string>> = {
  DAMAGED: 'This helmet is marked as damaged.',
  RECALLED: 'This helmet is subject to a manufacturer recall. Do not continue to ride with it.',
};

/** Messages for the person-focused emergency page. Helmet wording only for helmet states. */
export const PUBLIC_STATE_MESSAGES: Record<PublicHelmetState, string> = {
  NOT_ACTIVATED: 'This Safety ID has not been activated yet.',
  ACTIVATED_PROFILE_INCOMPLETE:
    'This Safety ID is registered, but its owner has not shared emergency information.',
  ACTIVE: 'Emergency information and contacts were provided by the owner and are not verified.',
  LOST: 'The helmet carrying this Safety ID has been reported lost.',
  STOLEN: 'The helmet carrying this Safety ID has been reported stolen.',
  DAMAGED: 'The helmet carrying this Safety ID is marked as damaged.',
  REPLACED: 'This Safety ID has been replaced and is no longer active.',
  DEACTIVATED: 'This Safety ID is no longer active.',
  RECALLED: 'The helmet carrying this Safety ID is subject to a manufacturer recall.',
  UNAVAILABLE: 'This Safety ID is not currently in use.',
};

/** Linked helmet retired: the QR on it no longer shows anyone's information. */
const HELMET_RETIRED_MESSAGES: Partial<Record<HelmetStatus, string>> = {
  REPLACED: 'The helmet carrying this Safety ID has been replaced and is no longer active.',
  DEACTIVATED: 'The helmet carrying this Safety ID is no longer active.',
};

export interface PublicStateDecision {
  state: PublicHelmetState;
  message: string;
  /** True when the caller should attach the (publishable) profile. */
  showProfile: boolean;
  warning?: string;
}

/**
 * Whether the profile may be decrypted at all for this Safety ID: it is in use, has an owner, and
 * a linked helmet (if any) is in a status that may still show it.
 */
export function mayShowProfile(
  status: SafetyIdStatus,
  hasOwner: boolean,
  helmetStatus: HelmetStatus | null,
): boolean {
  if (status !== 'ACTIVE' || !hasOwner) return false;
  return helmetStatus === null || !PROFILE_HIDDEN_HELMET_STATUSES.includes(helmetStatus);
}

/**
 * What the unauthenticated QR page may reveal: a retired Safety ID first, then the linked
 * helmet's lifecycle, then activation and sharing (standalone Safety IDs never get helmet states).
 */
export function toPublicState(
  status: SafetyIdStatus,
  helmetStatus: HelmetStatus | null,
  owner: OwnerContext,
): PublicStateDecision {
  const plain = (state: PublicHelmetState, message = PUBLIC_STATE_MESSAGES[state]) => ({
    state,
    message,
    showProfile: false,
  });
  // 1. The Safety ID itself retired.
  if (status === 'DEACTIVATED') return plain(PublicHelmetState.DEACTIVATED);
  if (status === 'REPLACED') return plain(PublicHelmetState.REPLACED);
  // 2. The linked helmet's lifecycle (also before activation, exactly as in Phase 8).
  switch (helmetStatus) {
    case 'LOST':
      return plain(PublicHelmetState.LOST);
    case 'STOLEN':
      return plain(PublicHelmetState.STOLEN);
    case 'REPLACED':
      return plain(PublicHelmetState.REPLACED, HELMET_RETIRED_MESSAGES.REPLACED);
    case 'DEACTIVATED':
      return plain(PublicHelmetState.DEACTIVATED, HELMET_RETIRED_MESSAGES.DEACTIVATED);
    case 'DAMAGED':
    case 'RECALLED': {
      const state =
        helmetStatus === 'DAMAGED' ? PublicHelmetState.DAMAGED : PublicHelmetState.RECALLED;
      if (owner.hasOwner && status === 'ACTIVE' && owner.profilePublishable)
        // Still sharing: owner disclaimer + explicit lifecycle warning.
        return {
          state,
          message: PUBLIC_STATE_MESSAGES.ACTIVE,
          showProfile: true,
          warning: LIFECYCLE_WARNINGS[helmetStatus],
        };
      return plain(state);
    }
    default:
      break;
  }
  // 3. Activation and sharing.
  if (status === 'GENERATED' || status === 'PRINTED') return plain(PublicHelmetState.NOT_ACTIVATED);
  // e.g. ownership revoked by support: no owner, nothing to show.
  if (!owner.hasOwner) return plain(PublicHelmetState.UNAVAILABLE);
  return status === 'ACTIVE' && owner.profilePublishable
    ? { state: PublicHelmetState.ACTIVE, message: PUBLIC_STATE_MESSAGES.ACTIVE, showProfile: true }
    : plain(PublicHelmetState.ACTIVATED_PROFILE_INCOMPLETE);
}
