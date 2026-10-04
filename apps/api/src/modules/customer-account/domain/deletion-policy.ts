import type { AccountDeletionStatus } from '@helmet/types';

export type DeletionAction = 'APPROVE' | 'REJECT' | 'COMPLETE' | 'CANCEL';

/**
 * Deletion request state machine. Nothing here erases data: COMPLETE marks the account deleted
 * (see PRIVACY-REQUESTS.md). Customers may cancel until the request is completed or rejected.
 */
const TRANSITIONS: Record<
  AccountDeletionStatus,
  Partial<Record<DeletionAction, AccountDeletionStatus>>
> = {
  REQUESTED: { APPROVE: 'APPROVED', REJECT: 'REJECTED', CANCEL: 'CANCELLED' },
  APPROVED: { COMPLETE: 'COMPLETED', REJECT: 'REJECTED', CANCEL: 'CANCELLED' },
  REJECTED: {},
  COMPLETED: {},
  CANCELLED: {},
};

export function nextDeletionStatus(
  from: AccountDeletionStatus,
  action: DeletionAction,
): AccountDeletionStatus | null {
  return TRANSITIONS[from][action] ?? null;
}

export const OPEN_DELETION_STATUSES: readonly AccountDeletionStatus[] = ['REQUESTED', 'APPROVED'];
