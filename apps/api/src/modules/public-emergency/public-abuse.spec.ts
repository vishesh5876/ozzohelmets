import type { AppConfigService } from '../../config/app-config.service';
import type { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { PublicAbuseService } from './public-abuse.service';

/** In-memory limiter with the same semantics as RedisRateLimiter (counts, no expiry). */
function memoryLimiter() {
  const counts = new Map<string, number>();
  return {
    counts,
    hit: async (key: string, limit: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { allowed: n <= limit, count: n, retryAfter: 60 };
    },
    peek: async (key: string, limit: number) => {
      const n = counts.get(key) ?? 0;
      return { allowed: n < limit, count: n, retryAfter: 60 };
    },
  };
}

const config = {
  get: (k: string) =>
    ({
      PUBLIC_MISS_LIMIT_PER_IP: 8,
      PUBLIC_MISS_WINDOW_SECONDS: 600,
      PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED: 2,
      PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE: 20,
    })[k],
} as unknown as AppConfigService;

describe('public QR abuse controls', () => {
  it('flags an IP only after repeated misses, then rations uncached lookups', async () => {
    const limiter = memoryLimiter();
    const abuse = new PublicAbuseService(limiter as unknown as RedisRateLimiter, config);
    for (let i = 0; i < 7; i++) await abuse.recordMiss('ip-a');
    expect(await abuse.isFlagged('ip-a')).toBe(false);
    await abuse.recordMiss('ip-a');
    expect(await abuse.isFlagged('ip-a')).toBe(true);
    expect(await abuse.isFlagged('ip-b')).toBe(false);
    expect((await abuse.allowUncached('ip-a')).allowed).toBe(true);
    expect((await abuse.allowUncached('ip-a')).allowed).toBe(true);
    expect((await abuse.allowUncached('ip-a')).allowed).toBe(false);
    // Requests without an IP hash are never blocked (no false positives on unknown clients).
    expect(await abuse.isFlagged(null)).toBe(false);
  });

  it('tightens per-IP budgets to a quarter during a global miss burst', async () => {
    const limiter = memoryLimiter();
    const abuse = new PublicAbuseService(limiter as unknown as RedisRateLimiter, config);
    limiter.counts.set('public-miss:global', 25);
    for (let i = 0; i < 2; i++) await abuse.recordMiss('ip-c');
    expect(await abuse.isFlagged('ip-c')).toBe(true);
  });
});
