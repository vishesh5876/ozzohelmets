import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed accessor over the validated environment. Inject this instead of reading process.env.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  /** Parses TRUST_PROXY into the value Express expects. */
  get trustProxy(): boolean | number | string {
    const raw = this.get('TRUST_PROXY').trim();
    if (raw === 'true') return true;
    if (raw === 'false' || raw === '') return false;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
  }

  publicHelmetUrl(publicToken: string): string {
    return `${this.get('PUBLIC_EMERGENCY_BASE_URL')}/e/${publicToken}`;
  }
}
