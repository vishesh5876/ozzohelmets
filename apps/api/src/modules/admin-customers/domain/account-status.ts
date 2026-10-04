import type {
  AdminCustomerStatusAction,
  CustomerSecurityEventType,
  UserStatus,
} from '@helmet/types';

/**
 * Admin account-status changes. DELETED is terminal here (marking deleted is a separate,
 * SUPER_ADMIN-only action). Brute-force lockouts are temporary and never change this status.
 */
const TARGET: Record<AdminCustomerStatusAction, UserStatus> = {
  SUSPEND: 'SUSPENDED',
  LOCK: 'LOCKED',
  RESTORE: 'ACTIVE',
};

const ALLOWED_FROM: Record<AdminCustomerStatusAction, readonly UserStatus[]> = {
  SUSPEND: ['ACTIVE', 'LOCKED'],
  LOCK: ['ACTIVE', 'SUSPENDED'],
  RESTORE: ['SUSPENDED', 'LOCKED'],
};

export function nextAccountStatus(
  from: UserStatus,
  action: AdminCustomerStatusAction,
): UserStatus | null {
  return ALLOWED_FROM[action].includes(from) ? TARGET[action] : null;
}

export const STATUS_EVENT: Record<AdminCustomerStatusAction, CustomerSecurityEventType> = {
  SUSPEND: 'ACCOUNT_SUSPENDED',
  LOCK: 'ACCOUNT_LOCKED',
  RESTORE: 'ACCOUNT_RESTORED',
};

/** Sign-in is possible only for ACTIVE accounts; QR emergency availability is independent. */
export const SIGN_IN_ALLOWED: readonly UserStatus[] = ['ACTIVE'];
