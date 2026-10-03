import { Injectable } from '@nestjs/common';
import type { PublicEmergencyDto } from '@helmet/types';
import { RedisCacheService } from '../../infrastructure/redis/redis-cache.service';

/** Internal cache entry; `helmetId` is used for scan logging and is never returned publicly. */
export interface CachedPublicHelmet {
  helmetId: string;
  dto: PublicEmergencyDto;
}

const TTL_SECONDS = 60;
const key = (token: string) => `public-emergency:v1:${token}`;

@Injectable()
export class PublicEmergencyCacheService {
  constructor(private readonly cache: RedisCacheService) {}

  get(token: string): Promise<CachedPublicHelmet | null> {
    return this.cache.getJson<CachedPublicHelmet>(key(token));
  }

  set(token: string, value: CachedPublicHelmet): Promise<void> {
    return this.cache.setJson(key(token), value, TTL_SECONDS);
  }

  /** Must be called after any change that affects the public page (status, profile, visibility, owner). */
  invalidate(...tokens: string[]): Promise<void> {
    return this.cache.del(...tokens.map(key));
  }
}
