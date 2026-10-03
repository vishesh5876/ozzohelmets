import { Injectable } from '@nestjs/common';
import type { PublicEmergencyDto } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisCacheService } from '../../infrastructure/redis/redis-cache.service';

/**
 * Cache entry: the already privacy-filtered public representation. `helmetId` is used for
 * scan logging only; `photoKey` is set only when the photo is publicly visible.
 * Raw (unfiltered) profile data is never cached.
 */
export interface CachedPublicHelmet {
  helmetId: string;
  dto: PublicEmergencyDto;
  photo?: { key: string; contentType: string } | null;
}

const key = (token: string) => `public-emergency:v2:${token}`;

@Injectable()
export class PublicEmergencyCacheService {
  constructor(
    private readonly cache: RedisCacheService,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  get(token: string): Promise<CachedPublicHelmet | null> {
    return this.cache.getJson<CachedPublicHelmet>(key(token));
  }

  set(token: string, value: CachedPublicHelmet): Promise<void> {
    return this.cache.setJson(key(token), value, this.config.get('PUBLIC_CACHE_TTL_SECONDS'));
  }

  /** Must be called after any change that affects the public page (status, profile, visibility, owner). */
  invalidate(...tokens: string[]): Promise<void> {
    return this.cache.del(...tokens.map(key));
  }

  /** Invalidates every helmet currently owned by the customer (profile/contacts/visibility changes). */
  async invalidateForOwner(userId: string): Promise<void> {
    const owned = await this.prisma.helmetOwnership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { helmet: { select: { publicToken: true } } },
    });
    await this.invalidate(...owned.map((o) => o.helmet.publicToken));
  }
}
