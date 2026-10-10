import { type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { metrics } from '../../infrastructure/metrics/metrics';
import { isRedisUnavailableError } from '../../infrastructure/redis/redis-errors';
import { resolvePolicy } from './rate-limit.decorator';

/**
 * Tracks by the resolved client IP (Cloudflare-aware) instead of the raw socket address.
 *
 * Redis outage: `public` and `default` routes fail open (emergency pages stay up; authenticated
 * routes still pass their own guards), `auth` routes fail closed — the error becomes a 503, so
 * login/recovery/activation brute-force protection is never silently switched off.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger(AppThrottlerGuard.name);
  private lastOutageLog = 0;

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (err) {
      if (!isRedisUnavailableError(err)) throw err;
      if (resolvePolicy(context.getHandler(), context.getClass()) === 'auth') throw err;
      metrics.dependencyUnavailable.inc({ dependency: 'redis', handling: 'throttle_fail_open' });
      if (Date.now() - this.lastOutageLog > 30_000) {
        this.lastOutageLog = Date.now();
        this.log.warn('Redis unavailable: route rate limits bypassed for public/default routes');
      }
      return true;
    }
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as Request & { clientIp?: string };
    return r.clientIp ?? r.ip ?? 'unknown';
  }
}
