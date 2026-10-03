import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { IpHashService } from '../../security/ip-hash.service';
import { getClientIp, truncateUserAgent } from './client-ip';
import { REQUEST_META_KEY, type RequestMeta } from './request-context';

@Injectable()
export class RequestMetaMiddleware implements NestMiddleware {
  constructor(
    private readonly config: AppConfigService,
    private readonly ipHash: IpHashService,
  ) {}

  use(
    req: Request & { [REQUEST_META_KEY]?: RequestMeta; clientIp?: string },
    _res: Response,
    next: NextFunction,
  ): void {
    const ip = getClientIp(req, this.config.get('TRUST_CLOUDFLARE'));
    req.clientIp = ip;
    req[REQUEST_META_KEY] = { ipHash: this.ipHash.hash(ip), userAgent: truncateUserAgent(req) };
    next();
  }
}
