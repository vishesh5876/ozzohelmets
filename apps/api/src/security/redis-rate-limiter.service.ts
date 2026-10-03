import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.constants';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return { count, ttl }
`;

/**
 * Atomic fixed-window counters for domain-level limits (per mobile, per helmet, per customer…)
 * that the route-level throttler cannot express. Keys must not contain raw personal data —
 * callers pass hashed identifiers.
 */
@Injectable()
export class RedisRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Counts a hit and reports whether it is within `limit` for the current window. */
  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(
      HIT_SCRIPT,
      1,
      `rl:${key}`,
      String(windowSeconds),
    )) as [number, number];
    return { allowed: count <= limit, count, retryAfter: Math.max(ttl, 0) };
  }

  /** Reads the current count without incrementing. */
  async peek(key: string, limit: number): Promise<RateLimitResult> {
    const [raw, ttl] = await Promise.all([
      this.redis.get(`rl:${key}`),
      this.redis.ttl(`rl:${key}`),
    ]);
    const count = Number(raw ?? 0);
    return { allowed: count < limit, count, retryAfter: Math.max(ttl, 0) };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }
}
