import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { IpHashService } from '../../security/ip-hash.service';
import { getClientIp, truncateUserAgent } from './client-ip';
import { REQUEST_META_KEY, type RequestMeta } from './request-context';

@Injectable()
export class RequestMetaMiddleware implements NestMiddleware {
  private readonly logger = new Logger('ClientIp');
  constructor(
    private readonly config: AppConfigService,
    private readonly ipHash: IpHashService,
  ) {}

  use(
    req: Request & { [REQUEST_META_KEY]?: RequestMeta; clientIp?: string },
    _res: Response,
    next: NextFunction,
  ): void {
    this.warnIfProxyUntrusted(req);
    const ip = getClientIp(req, this.config.get('TRUST_CLOUDFLARE'));
    req.clientIp = ip;
    req[REQUEST_META_KEY] = { ipHash: this.ipHash.hash(ip), userAgent: truncateUserAgent(req) };
    next();
  }

  private lastProxyWarning = 0;

  /**
   * Requests arriving with X-Forwarded-For / CF-Connecting-IP while no proxy is trusted usually
   * mean a misconfigured deployment: every client then shares the proxy's IP (one rate-limit
   * budget, one analytics "visitor"). Logged at most once per 10 minutes; headers never trusted.
   */
  private warnIfProxyUntrusted(req: Request): void {
    if (this.config.trustProxy !== false || this.config.get('TRUST_CLOUDFLARE')) return;
    if (!req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip']) return;
    if (Date.now() - this.lastProxyWarning < 600_000) return;
    this.lastProxyWarning = Date.now();
    this.logger.error(
      'Forwarded client-IP headers received but TRUST_PROXY/TRUST_CLOUDFLARE are off: all clients may share one IP identity. See docs/DEPLOYMENT.md.',
    );
  }
}
