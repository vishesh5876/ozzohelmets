import { HttpStatus } from '@nestjs/common';
import { ErrorCode, type HelmetStatus, type OwnerHelmetAction, ownerActions } from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';

/**
 * Central lifecycle rules for owner and support actions. Status edges themselves live in the
 * shared transition table and are enforced by HelmetStatusService; this policy decides which
 * explicit action is valid now and where a restore returns to.
 */
export function assertOwnerAction(status: HelmetStatus, action: OwnerHelmetAction): void {
  if (ownerActions(status).includes(action)) return;
  throw new AppException(code(status, action), message(status, action), HttpStatus.CONFLICT, {
    status,
  });
}

/** LOST/STOLEN restores, and support restores, return to the remembered operational state —
 *  but only to ACTIVE if this owner's information may still be exposed on this helmet. */
export function restoreTarget(
  previous: HelmetStatus | null,
  canExpose: boolean,
): 'ACTIVE' | 'ACTIVATED' {
  return previous === 'ACTIVE' && canExpose ? 'ACTIVE' : 'ACTIVATED';
}

/** Statuses support may restore for an owned helmet. */
export const SUPPORT_RESTORABLE: readonly HelmetStatus[] = [
  'LOST',
  'STOLEN',
  'DAMAGED',
  'DEACTIVATED',
];

function code(status: HelmetStatus, action: OwnerHelmetAction): ErrorCode {
  if (status === 'REPLACED') return ErrorCode.HELMET_REPLACED;
  switch (action) {
    case 'TRANSFER':
      return ErrorCode.HELMET_NOT_TRANSFERABLE;
    case 'REPORT_LOST':
      return status === 'LOST'
        ? ErrorCode.HELMET_ALREADY_LOST
        : ErrorCode.HELMET_ACTION_NOT_ALLOWED;
    case 'REPORT_STOLEN':
      return status === 'STOLEN'
        ? ErrorCode.HELMET_ALREADY_STOLEN
        : ErrorCode.HELMET_ACTION_NOT_ALLOWED;
    case 'MARK_FOUND':
      return ErrorCode.HELMET_NOT_LOST;
    case 'MARK_RECOVERED':
      return ErrorCode.HELMET_NOT_STOLEN;
    case 'RETIRE':
      return ErrorCode.HELMET_NOT_DEACTIVATABLE;
    default:
      return ErrorCode.HELMET_ACTION_NOT_ALLOWED;
  }
}

function message(status: HelmetStatus, action: OwnerHelmetAction): string {
  if (status === 'REPLACED') return 'This helmet has been replaced and can no longer be changed.';
  switch (action) {
    case 'TRANSFER':
      return 'This helmet can’t be transferred in its current state.';
    case 'MARK_FOUND':
      return 'This helmet is not reported lost.';
    case 'MARK_RECOVERED':
      return 'This helmet is not reported stolen.';
    case 'RETIRE':
      return 'This helmet can’t be retired in its current state.';
    default:
      return 'This action isn’t available for the helmet in its current state.';
  }
}
