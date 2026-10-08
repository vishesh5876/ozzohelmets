import type Redis from 'ioredis';
import type { AppConfigService } from '../../config/app-config.service';
import type { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import type { RaiseAlertInput, RiskAlertsService } from '../analytics/risk-alerts.service';
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

/** Just enough of ioredis for the abuse service (strings, exact sets as HyperLogLogs, TTLs). */
function memoryRedis() {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();
  const redis = {
    strings,
    sets,
    exists: async (k: string) => (strings.has(k) || sets.has(k) ? 1 : 0),
    ttl: async (k: string) => ttls.get(k) ?? -1,
    expire: async (k: string, s: number) => {
      ttls.set(k, s);
      return 1;
    },
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string, _ex: string, s: number, nx?: string) => {
      if (nx === 'NX' && strings.has(k)) return null;
      strings.set(k, v);
      ttls.set(k, s);
      return 'OK';
    },
    pfadd: async (k: string, v: string) => {
      const set = sets.get(k) ?? new Set<string>();
      sets.set(k, set);
      const before = set.size;
      set.add(v);
      return set.size > before ? 1 : 0;
    },
    multi: () => {
      const ops: (() => Promise<unknown>)[] = [];
      const chain = {
        incr: (k: string) => {
          ops.push(async () => {
            const n = Number(strings.get(k) ?? 0) + 1;
            strings.set(k, String(n));
            return n;
          });
          return chain;
        },
        expire: (k: string, s: number) => {
          ops.push(() => redis.expire(k, s));
          return chain;
        },
        ttl: (k: string) => {
          ops.push(() => redis.ttl(k));
          return chain;
        },
        pfcount: (k: string) => {
          ops.push(async () => sets.get(k)?.size ?? 0);
          return chain;
        },
        exec: async () => {
          const out: [null, unknown][] = [];
          for (const op of ops) out.push([null, await op()]);
          return out;
        },
      };
      return chain;
    },
  };
  return redis;
}

function fakeAlerts() {
  const raised: RaiseAlertInput[] = [];
  return { raised, raiseSafe: (i: RaiseAlertInput) => void raised.push(i) };
}

const config = {
  get: (k: string) =>
    ({
      PUBLIC_MISS_LIMIT_PER_IP: 8,
      PUBLIC_MISS_WINDOW_SECONDS: 600,
      PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED: 2,
      PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE: 20,
      ENUMERATION_INVALID_TOKEN_LIMIT: 6,
      VALID_TOKEN_SCRAPE_LIMIT: 5,
      VALID_TOKEN_SCRAPE_WINDOW_SECONDS: 3600,
      VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER: 2,
    })[k],
} as unknown as AppConfigService;

function setup() {
  const limiter = memoryLimiter();
  const redis = memoryRedis();
  const alerts = fakeAlerts();
  const abuse = new PublicAbuseService(
    limiter as unknown as RedisRateLimiter,
    config,
    redis as unknown as Redis,
    alerts as unknown as RiskAlertsService,
  );
  return { limiter, redis, alerts, abuse };
}

describe('public QR abuse controls', () => {
  it('flags an IP only after repeated misses, then rations uncached lookups', async () => {
    const { abuse } = setup();
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

  it('tightens per-IP budgets to a quarter during a global miss burst and alerts once', async () => {
    const { abuse, limiter, alerts } = setup();
    limiter.counts.set('public-miss:global', 25);
    for (let i = 0; i < 2; i++) await abuse.recordMiss('ip-c');
    expect(await abuse.isFlagged('ip-c')).toBe(true);
    await abuse.isFlagged('ip-c');
    expect(alerts.raised.filter((a) => a.type === 'SYSTEM_RATE_LIMIT_SPIKE')).toHaveLength(1);
  });

  it('raises one TOKEN_ENUMERATION alert per source with counts only (no tokens, no IP)', async () => {
    const { abuse, alerts, redis } = setup();
    for (let i = 0; i < 10; i++) await abuse.recordMiss('ip-enum');
    const enumAlerts = alerts.raised.filter((a) => a.type === 'TOKEN_ENUMERATION');
    expect(enumAlerts).toHaveLength(1);
    expect(enumAlerts[0]!.observedValue).toBe(6);
    expect(JSON.stringify(enumAlerts[0])).not.toContain('ip-enum');
    expect(enumAlerts[0]!.sourceRef).toMatch(/^[0-9a-f]{12}$/);
    // The daily counter feeds platform_daily_stats.invalid_token_requests.
    const day = [...redis.strings.keys()].find((k) => k.startsWith('analytics:invalid-tokens:'));
    expect(redis.strings.get(day!)).toBe('10');
  });

  it('detects valid-token scraping: flag, then block uncached lookups, without counting repeats', async () => {
    const { abuse, alerts } = setup();
    // Re-scanning the same helmet many times is not scraping.
    for (let i = 0; i < 50; i++) await abuse.recordValidAccess('ip-s', 'helmet-1');
    expect(await abuse.isFlagged('ip-s')).toBe(false);
    for (let i = 2; i <= 6; i++) await abuse.recordValidAccess('ip-s', `helmet-${i}`);
    expect(await abuse.isFlagged('ip-s')).toBe(true);
    expect((await abuse.allowUncached('ip-s')).allowed).toBe(true);
    for (let i = 7; i <= 11; i++) await abuse.recordValidAccess('ip-s', `helmet-${i}`);
    const blocked = await abuse.allowUncached('ip-s');
    expect(blocked.allowed).toBe(false);
    const scrape = alerts.raised.filter((a) => a.type === 'VALID_TOKEN_SCRAPING');
    expect(scrape.map((a) => a.priority)).toEqual(['MEDIUM', 'HIGH']);
    expect(scrape.every((a) => a.dedupKey === scrape[0]!.dedupKey)).toBe(true);
    // Another source is unaffected.
    expect((await abuse.allowUncached('ip-other')).allowed).toBe(true);
  });
});
