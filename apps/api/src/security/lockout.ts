import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.constants';

/**
 * Escalating cooldown: every `threshold` consecutive failures starts a lock of
 * base × 2^(n−1) seconds, capped at `max`. Returns 0 when no lock should start.
 * Locks are always temporary, so hostile traffic can delay but never permanently lock out a
 * legitimate owner.
 */
export function escalatingLockSeconds(
  failures: number,
  threshold: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  if (failures <= 0 || failures % threshold !== 0) return 0;
  return Math.min(baseSeconds * 2 ** (failures / threshold - 1), maxSeconds);
}

export interface LockoutPolicy {
  threshold: number;
  baseSeconds: number;
  maxSeconds: number;
  /** How long the failure counter is remembered without new failures. */
  memorySeconds?: number;
}

export interface LockoutState {
  locked: boolean;
  retryAfter: number;
  failures: number;
}

/** Atomic: count the failure and, on every `threshold`-th one, start an escalating lock. */
const FAIL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
local threshold = tonumber(ARGV[2])
local lock = 0
if count % threshold == 0 then
  lock = math.floor(math.min(tonumber(ARGV[3]) * 2 ^ (count / threshold - 1), tonumber(ARGV[4])))
  redis.call('SET', KEYS[2], '1', 'EX', lock)
end
return { count, lock }
`;

/** Redis-backed escalating lockouts for login and recovery (keys must use hashed identifiers). */
@Injectable()
export class LockoutService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async status(key: string): Promise<LockoutState> {
    const [ttl, failures] = await Promise.all([
      this.redis.ttl(`lock:${key}:locked`),
      this.redis.get(`lock:${key}:fails`),
    ]);
    return { locked: ttl > 0, retryAfter: Math.max(ttl, 0), failures: Number(failures ?? 0) };
  }

  async fail(key: string, policy: LockoutPolicy): Promise<LockoutState> {
    const [failures, lockSeconds] = (await this.redis.eval(
      FAIL_SCRIPT,
      2,
      `lock:${key}:fails`,
      `lock:${key}:locked`,
      String(policy.memorySeconds ?? 86_400),
      String(policy.threshold),
      String(policy.baseSeconds),
      String(policy.maxSeconds),
    )) as [number, number];
    return { locked: lockSeconds > 0, retryAfter: lockSeconds, failures };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`lock:${key}:fails`, `lock:${key}:locked`);
  }
}
