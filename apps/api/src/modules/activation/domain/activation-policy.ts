import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACTIVATABLE_STATUSES,
  ErrorCode,
  type HelmetStatus,
  SAFETY_ID_ACTIVATABLE,
  type SafetyIdStatus,
} from '@helmet/types';
import { AppConfigService } from '../../../config/app-config.service';
import { escalatingLockSeconds } from '../../../security/lockout';

/** Snapshot of a (row-locked) Safety ID used to decide whether activation may proceed. */
export interface ActivationSnapshot {
  status: SafetyIdStatus;
  activationPinUsed: boolean;
  hasActiveOwner: boolean;
  activationLockedUntil: Date | null;
}

/** The linked helmet (row-locked) and who would become the owner. */
export interface LinkSnapshot {
  helmet: { status: HelmetStatus; ownerId: string | null } | null;
  /** Existing customer activating; null for a brand-new account. */
  actingUserId: string | null;
}

export interface ActivationDenial {
  code: ErrorCode;
  message: string;
  status: HttpStatus;
  details?: Record<string, unknown>;
}

/** Post-activation Safety ID statuses: activation already happened. */
const ALREADY_ACTIVATED: readonly SafetyIdStatus[] = ['ACTIVATED', 'ACTIVE'];

/**
 * Pure decision: null means "may proceed to PIN verification". Order matters — already
 * activated wins over everything so concurrent losers get SAFETY_ID_ALREADY_ACTIVATED.
 */
export function evaluateActivation(
  s: ActivationSnapshot,
  allowedStatuses: readonly SafetyIdStatus[],
  now: Date,
): ActivationDenial | null {
  if (s.activationPinUsed || ALREADY_ACTIVATED.includes(s.status)) {
    return {
      code: ErrorCode.SAFETY_ID_ALREADY_ACTIVATED,
      message: 'This Safety ID has already been activated.',
      status: HttpStatus.CONFLICT,
    };
  }
  if (s.hasActiveOwner) {
    return {
      code: ErrorCode.SAFETY_ID_HAS_OWNER,
      message: 'This Safety ID already has an owner.',
      status: HttpStatus.CONFLICT,
    };
  }
  if (!allowedStatuses.includes(s.status)) {
    return {
      code: ErrorCode.SAFETY_ID_NOT_ACTIVATABLE,
      message: 'This Safety ID cannot be activated. Contact support.',
      status: HttpStatus.CONFLICT,
    };
  }
  if (s.activationLockedUntil && s.activationLockedUntil.getTime() > now.getTime()) {
    const retryAfter = Math.ceil((s.activationLockedUntil.getTime() - now.getTime()) / 1000);
    return {
      code: ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED,
      message: 'Too many incorrect PIN attempts for this Safety ID. Try again later.',
      status: HttpStatus.TOO_MANY_REQUESTS,
      details: { retryAfter },
    };
  }
  return null;
}

/**
 * Linked-helmet rule, checked only AFTER the PIN was verified (so it is no ownership oracle):
 * the helmet must be unowned and still activatable — it then becomes the same customer's —
 * or already owned by the activating customer. Anything else would split ownership.
 */
export function evaluateLink(l: LinkSnapshot): ActivationDenial | null {
  if (!l.helmet) return null;
  if (l.helmet.ownerId) {
    if (l.actingUserId && l.helmet.ownerId === l.actingUserId) return null;
    return {
      code: ErrorCode.SAFETY_ID_LINK_CONFLICT,
      message:
        'The helmet linked to this Safety ID is registered to another account. Contact support.',
      status: HttpStatus.CONFLICT,
    };
  }
  if (!ACTIVATABLE_STATUSES.includes(l.helmet.status)) {
    return {
      code: ErrorCode.SAFETY_ID_NOT_ACTIVATABLE,
      message:
        'The helmet linked to this Safety ID cannot be activated in its current state. Contact support.',
      status: HttpStatus.CONFLICT,
      details: { helmetStatus: l.helmet.status },
    };
  }
  return null;
}

/** Progressive per-Safety-ID lockout after repeated wrong PINs (temporary, capped at 24 h). */
export function lockoutAfterFailure(
  failures: number,
  threshold: number,
  baseSeconds: number,
  now: Date,
): Date | null {
  const seconds = escalatingLockSeconds(failures, threshold, baseSeconds, 86_400);
  return seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;
}

/**
 * Single source of truth for activation eligibility. Possession of the one-time PIN printed with
 * the Safety ID is the proof; no sale record is required (docs/ADR-001-no-retail-inventory.md).
 */
@Injectable()
export class ActivationPolicy {
  constructor(private readonly config: AppConfigService) {}

  allowedStatuses(): readonly SafetyIdStatus[] {
    return SAFETY_ID_ACTIVATABLE;
  }

  evaluate(snapshot: ActivationSnapshot, now: Date = new Date()): ActivationDenial | null {
    return evaluateActivation(snapshot, this.allowedStatuses(), now);
  }

  evaluateLink(snapshot: LinkSnapshot): ActivationDenial | null {
    return evaluateLink(snapshot);
  }

  lockoutAfterFailure(failures: number, now: Date = new Date()): Date | null {
    return lockoutAfterFailure(
      failures,
      this.config.get('ACTIVATION_FAILURES_BEFORE_LOCK'),
      this.config.get('ACTIVATION_LOCKOUT_BASE_SECONDS'),
      now,
    );
  }
}
