import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/** Tracks by the resolved client IP (Cloudflare-aware) instead of the raw socket address. */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as Request & { clientIp?: string };
    return r.clientIp ?? r.ip ?? 'unknown';
  }
}
