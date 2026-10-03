import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_POLICY_KEY = 'rate-limit:policy';

/**
 * - `default`: generous limit for authenticated/admin traffic.
 * - `auth`:    strict limit for credential endpoints (login, recovery, activation, admin refresh).
 * - `public`:  emergency QR endpoints — abuse-protected but deliberately lenient so real
 *              emergencies are never blocked.
 */
export type RateLimitPolicy = 'default' | 'auth' | 'public';

export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT_POLICY_KEY, policy);

export function resolvePolicy(handler: object, controller: object): RateLimitPolicy {
  return (
    (Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler) as RateLimitPolicy | undefined) ??
    (Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, controller) as RateLimitPolicy | undefined) ??
    'default'
  );
}
