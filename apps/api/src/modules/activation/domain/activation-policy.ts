import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACTIVATABLE_STATUSES,
  CONDITIONALLY_ACTIVATABLE_STATUSES,
  ErrorCode,
  type HelmetStatus,
} from '@helmet/types';
import { AppConfigService } from '../../../config/app-config.service';

/** Snapshot of a (row-locked) helmet used to decide whether activation may proceed. */
export interface ActivationSnapshot {
  status: HelmetStatus;
  activationPinUsed: boolean;
  hasActiveOwner: boolean;
  activationLockedUntil: Date | null;
}

export interface ActivationDenial {
  code: ErrorCode;
  message: string;
  status: HttpStatus;
  details?: Record<string, unknown>;
}

/** Post-activation statuses: the helmet already went through activation. */
const ALREADY_ACTIVATED: readonly HelmetStatus[] = ['ACTIVATED', 'ACTIVE', 'LOST', 'STOLEN'];

/**
 * Pure decision: null means "may proceed to PIN verification". Order matters — already
 * activated wins over everything so concurrent losers get HELMET_ALREADY_ACTIVATED.
 */
export function evaluateActivation(
  s: ActivationSnapshot,
  allowedStatuses: readonly HelmetStatus[],
  now: Date,
): ActivationDenial | null {
  if (s.activationPinUsed || ALREADY_ACTIVATED.includes(s.status)) {
    return {
      code: ErrorCode.HELMET_ALREADY_ACTIVATED,
      message: 'This helmet has already been activated.',
      status: HttpStatus.CONFLICT,
    };
  }
  if (s.hasActiveOwner) {
    return {
      code: ErrorCode.HELMET_HAS_OWNER,
      message: 'This helmet already has an owner.',
      status: HttpStatus.CONFLICT,
    };
  }
  if (!allowedStatuses.includes(s.status)) {
    return {
      code: ErrorCode.HELMET_NOT_ACTIVATABLE,
      message: 'This helmet cannot be activated. Contact your retailer or support.',
      status: HttpStatus.CONFLICT,
    };
  }
  if (s.activationLockedUntil && s.activationLockedUntil.getTime() > now.getTime()) {
    const retryAfter = Math.ceil((s.activationLockedUntil.getTime() - now.getTime()) / 1000);
    return {
      code: ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED,
      message: 'Too many incorrect PIN attempts for this helmet. Try again later.',
      status: HttpStatus.TOO_MANY_REQUESTS,
      details: { retryAfter },
    };
  }
  return null;
}

/**
 * Progressive lockout: every `threshold` consecutive failures locks the helmet for
 * base × 2^(n-1) seconds (capped at 24 h). Returns null when no lock should start.
 */
export function lockoutAfterFailure(
  failures: number,
  threshold: number,
  baseSeconds: number,
  now: Date,
): Date | null {
  if (failures <= 0 || failures % threshold !== 0) return null;
  const step = failures / threshold;
  const seconds = Math.min(baseSeconds * 2 ** (step - 1), 86_400);
  return new Date(now.getTime() + seconds * 1000);
}

/** Single source of truth for which statuses a customer may activate from. */
@Injectable()
export class ActivationPolicy {
  constructor(private readonly config: AppConfigService) {}

  allowedStatuses(): readonly HelmetStatus[] {
    return this.config.get('ACTIVATION_ALLOW_IN_INVENTORY')
      ? [...ACTIVATABLE_STATUSES, ...CONDITIONALLY_ACTIVATABLE_STATUSES]
      : ACTIVATABLE_STATUSES;
  }

  evaluate(snapshot: ActivationSnapshot, now: Date = new Date()): ActivationDenial | null {
    return evaluateActivation(snapshot, this.allowedStatuses(), now);
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
