import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Raw IPs are never persisted. A keyed HMAC lets us correlate abuse from the same address
 * without being reversible by someone who only has the database.
 */
@Injectable()
export class IpHashService {
  private readonly secret: string;

  constructor(config: AppConfigService) {
    this.secret = config.get('IP_HASH_SECRET');
  }

  hash(ip: string | null | undefined): string | null {
    if (!ip || ip === 'unknown') return null;
    return createHmac('sha256', this.secret).update(ip).digest('hex');
  }
}
