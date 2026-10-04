import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';

export type PublicAccessDecision = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * Adaptive abuse control for the public QR pages, separate from login/activation limits.
 *
 * Emergency access must stay available, so real scans are never what gets counted: only
 * "misses" — malformed or unknown tokens, which genuine QR codes don't produce. An IP whose misses
 * exceed `PUBLIC_MISS_LIMIT_PER_IP` per window is *flagged*: it keeps being served helmets already
 * in the public cache, plus a small allowance of uncached lookups per window, but can no longer
 * walk the token space. When the global miss rate exceeds `PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE`
 * (a distributed enumeration burst), per-IP budgets tighten to a quarter. No CAPTCHA, no blocking
 * of cached emergency pages. IPs are only ever seen as keyed HMACs.
 */
@Injectable()
export class PublicAbuseService {
  private readonly logger = new Logger(PublicAbuseService.name);
  private lastBurstLog = 0;

  constructor(
    private readonly limiter: RedisRateLimiter,
    private readonly config: AppConfigService,
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
    return Math.max(1, Math.floor(base / 4));
  }

  /** True when this IP produced too many unknown/malformed token lookups recently. */
  async isFlagged(ipHash: string | null): Promise<boolean> {
    if (!ipHash) return false;
    const state = await this.limiter.peek(`public-miss:ip:${ipHash}`, await this.missLimit());
    return !state.allowed;
  }

  /** Records a malformed/unknown token lookup (per IP and globally). */
  async recordMiss(ipHash: string | null): Promise<void> {
    const window = this.config.get('PUBLIC_MISS_WINDOW_SECONDS');
    await Promise.all([
      this.limiter.hit('public-miss:global', Number.MAX_SAFE_INTEGER, 60),
      ipHash
        ? this.limiter.hit(`public-miss:ip:${ipHash}`, Number.MAX_SAFE_INTEGER, window)
        : Promise.resolve(),
    ]);
  }

  /**
   * A flagged IP asking for a helmet that is not in the public cache: allowed within a small
   * per-window budget (so a responder behind a shared/CGNAT address still gets through).
   */
  async allowUncached(ipHash: string | null): Promise<PublicAccessDecision> {
    if (!ipHash) return { allowed: true };
    const res = await this.limiter.hit(
      `public-uncached:ip:${ipHash}`,
      this.config.get('PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED'),
      this.config.get('PUBLIC_MISS_WINDOW_SECONDS'),
    );
    return res.allowed ? { allowed: true } : { allowed: false, retryAfter: res.retryAfter };
  }
}
