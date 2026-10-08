import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { invalidTokenCounterKey, utcDay } from '../analytics/analytics-aggregation.service';
import { RiskAlertsService, sourceRefFor } from '../analytics/risk-alerts.service';

export type PublicAccessDecision = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * Adaptive abuse control for the public QR pages, separate from login/activation limits.
 *
 * Emergency access must stay available, so real scans of known helmets are the most tolerated:
 * - **Misses** (malformed/unknown tokens) — genuine QR codes don't produce them. An IP over
 *   `PUBLIC_MISS_LIMIT_PER_IP` per window is *flagged*; above `ENUMERATION_INVALID_TOKEN_LIMIT` a
 *   `TOKEN_ENUMERATION` alert is raised (once per source per window).
 * - **Valid-token scraping** (Phase 6) — one IP reaching more than `VALID_TOKEN_SCRAPE_LIMIT`
 *   distinct valid helmets per window (Redis HyperLogLog, no list of helmets kept) is flagged and
 *   a `VALID_TOKEN_SCRAPING` alert raised; above `VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER ×` the limit
 *   its uncached lookups are refused.
 * - A flagged IP is still served every helmet already in the public cache, plus
 *   `PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED` uncached lookups per window (shared/CGNAT addresses).
 * - A global miss burst tightens per-IP miss budgets to a quarter and raises one
 *   `SYSTEM_RATE_LIMIT_SPIKE` alert per hour.
 * No CAPTCHA. IPs are only seen as keyed HMACs; alerts carry an opaque source reference, never the
 * IP, the IP hash or attempted tokens.
 */
@Injectable()
export class PublicAbuseService {
  private readonly logger = new Logger(PublicAbuseService.name);
  private lastBurstLog = 0;

  constructor(
    private readonly limiter: RedisRateLimiter,
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly alerts: RiskAlertsService,
  ) {}

  private async missLimit(): Promise<number> {
    const base = this.config.get('PUBLIC_MISS_LIMIT_PER_IP');
    const global = await this.limiter.peek(
      'public-miss:global',
      this.config.get('PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE'),
    );
    if (global.allowed) return base;
    if (Date.now() - this.lastBurstLog > 60_000) {
      this.lastBurstLog = Date.now();
      this.logger.warn('Global public-token miss burst detected; tightening per-IP budgets');
    }
    const hour = new Date().toISOString().slice(0, 13);
    if (await this.once(`risk-alerted:miss-burst:${hour}`, 3600))
      this.alerts.raiseSafe({
        type: 'SYSTEM_RATE_LIMIT_SPIKE',
        dedupKey: 'system:miss-burst',
        priority: 'MEDIUM',
        summary: `Spike in unknown or malformed QR code requests (more than ${this.config.get('PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE')} per minute across all sources). Per-source limits tightened automatically.`,
        observedValue: global.count,
        thresholdValue: this.config.get('PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE'),
      });
    return Math.max(1, Math.floor(base / 4));
  }

  /** True when this IP produced too many misses or is scraping valid helmets. */
  async isFlagged(ipHash: string | null): Promise<boolean> {
    if (!ipHash) return false;
    if ((await this.redis.exists(`scrape-flag:ip:${ipHash}`)) === 1) return true;
    const state = await this.limiter.peek(`public-miss:ip:${ipHash}`, await this.missLimit());
    return !state.allowed;
  }

  /** Records a malformed/unknown token lookup (per IP, globally and in the daily counter). */
  async recordMiss(ipHash: string | null): Promise<void> {
    const window = this.config.get('PUBLIC_MISS_WINDOW_SECONDS');
    const day = invalidTokenCounterKey(utcDay(new Date()));
    const [, , ip] = await Promise.all([
      this.limiter.hit('public-miss:global', Number.MAX_SAFE_INTEGER, 60),
      this.redis
        .multi()
        .incr(day)
        .expire(day, 8 * 86_400)
        .exec()
        .catch(() => null),
      ipHash
        ? this.limiter.hit(`public-miss:ip:${ipHash}`, Number.MAX_SAFE_INTEGER, window)
        : Promise.resolve(null),
    ]);
    const limit = this.config.get('ENUMERATION_INVALID_TOKEN_LIMIT');
    if (ipHash && ip && ip.count >= limit && (await this.once(`risk-alerted:enum:${ipHash}`, window))) {
      const ref = sourceRefFor(ipHash);
      this.alerts.raiseSafe({
        type: 'TOKEN_ENUMERATION',
        dedupKey: `source:${ref}:enumeration`,
        priority: ip.count >= limit * 4 ? 'HIGH' : 'MEDIUM',
        sourceRef: ref,
        summary: `One source requested ${ip.count} unknown or malformed QR codes within ${Math.round(window / 60)} minutes (threshold ${limit}). Automatic throttling applied.`,
        observedValue: ip.count,
        thresholdValue: limit,
      });
    }
  }

  /**
   * Records a lookup of a valid helmet for scraping detection. Never blocks the current request;
   * at most a few Redis operations (PFADD, and PFCOUNT only when the set changed).
   */
  async recordValidAccess(ipHash: string | null, helmetId: string): Promise<void> {
    if (!ipHash) return;
    const window = this.config.get('VALID_TOKEN_SCRAPE_WINDOW_SECONDS');
    const key = `scrape:ip:${ipHash}`;
    const added = await this.redis.pfadd(key, helmetId);
    if (added !== 1) return;
    const [[, ttl], [, count]] = (await this.redis.multi().ttl(key).pfcount(key).exec()) as [
      [unknown, number],
      [unknown, number],
    ];
    if (ttl < 0) await this.redis.expire(key, window);
    const limit = this.config.get('VALID_TOKEN_SCRAPE_LIMIT');
    if (count <= limit) return;
    await this.redis.set(`scrape-flag:ip:${ipHash}`, '1', 'EX', window);
    const blocking = count > limit * this.config.get('VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER');
    if (blocking) await this.redis.set(`scrape-block:ip:${ipHash}`, '1', 'EX', window);
    if (await this.once(`risk-alerted:scrape:${ipHash}:${blocking ? 'block' : 'flag'}`, window)) {
      const ref = sourceRefFor(ipHash);
      this.alerts.raiseSafe({
        type: 'VALID_TOKEN_SCRAPING',
        dedupKey: `source:${ref}:scraping`,
        priority: blocking ? 'HIGH' : 'MEDIUM',
        sourceRef: ref,
        summary: `One source accessed about ${count} different valid helmets within ${Math.round(window / 60)} minutes (threshold ${limit}). ${blocking ? 'Uncached lookups from this source are now refused; cached emergency pages stay available.' : 'Uncached lookups from this source are rationed.'}`,
        observedValue: count,
        thresholdValue: limit,
      });
    }
  }

  /**
   * A flagged IP asking for a helmet that is not in the public cache: allowed within a small
   * per-window budget, unless the source crossed the scraping block threshold.
   */
  async allowUncached(ipHash: string | null): Promise<PublicAccessDecision> {
    if (!ipHash) return { allowed: true };
    const window = this.config.get('PUBLIC_MISS_WINDOW_SECONDS');
    if ((await this.redis.exists(`scrape-block:ip:${ipHash}`)) === 1)
      return { allowed: false, retryAfter: Math.max(await this.redis.ttl(`scrape-block:ip:${ipHash}`), 1) };
    const res = await this.limiter.hit(
      `public-uncached:ip:${ipHash}`,
      this.config.get('PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED'),
      window,
    );
    return res.allowed ? { allowed: true } : { allowed: false, retryAfter: res.retryAfter };
  }

  /** True the first time per TTL (alert gating so the database isn't written per request). */
  private async once(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX').catch(() => null)) === 'OK';
  }
}
