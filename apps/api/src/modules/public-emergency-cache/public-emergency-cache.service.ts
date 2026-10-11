import { Injectable } from '@nestjs/common';
import type { PublicEmergencyDto, PublicProductVerificationDto } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisCacheService } from '../../infrastructure/redis/redis-cache.service';

/**
 * Cache entry: the already privacy-filtered public representation, keyed by the QR token.
 * `safetyId` / `helmetId` are used for scan logging only; `photo` is set only when the photo is
 * publicly visible. Raw (unfiltered) profile data is never cached.
 */
export interface CachedPublicSafetyId {
  safetyId: string;
  /** Linked helmet at load time (null for standalone Safety IDs). */
  helmetId: string | null;
  dto: PublicEmergencyDto;
  photo?: { key: string; contentType: string } | null;
}

// v3 (Phase 9): new payload shape (Safety ID, no product fields). Old v2 entries are ignored.
const key = (token: string) => `public-emergency:v3:${token}`;
const verifyKey = (token: string) => `public-verify:v2:${token}`;

@Injectable()
export class PublicEmergencyCacheService {
  constructor(
    private readonly cache: RedisCacheService,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  get(token: string): Promise<CachedPublicSafetyId | null> {
    return this.cache.getJson<CachedPublicSafetyId>(key(token));
  }

  set(token: string, value: CachedPublicSafetyId): Promise<void> {
    return this.cache.setJson(key(token), value, this.config.get('PUBLIC_CACHE_TTL_SECONDS'));
  }

  getVerification(token: string): Promise<PublicProductVerificationDto | null> {
    return this.cache.getJson<PublicProductVerificationDto>(verifyKey(token));
  }

  setVerification(token: string, value: PublicProductVerificationDto): Promise<void> {
    return this.cache.setJson(verifyKey(token), value, this.config.get('PUBLIC_CACHE_TTL_SECONDS'));
  }

  /**
   * Must be called after any change that affects the public pages (status, profile, visibility,
   * owner, warranty). Clears both the emergency view and the product verification view.
   */
  invalidate(...tokens: (string | null | undefined)[]): Promise<void> {
    const live = tokens.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (live.length === 0) return Promise.resolve();
    return this.cache.del(...live.flatMap((t) => [key(t), verifyKey(t)]));
  }

  /**
   * Invalidates every Safety ID currently owned by the customer (profile, contacts, visibility,
   * account status changes). Phase 9: QR tokens belong to Safety IDs.
   */
  async invalidateForOwner(userId: string): Promise<void> {
    const owned = await this.prisma.safetyIdOwnership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { safetyIdRef: { select: { publicToken: true } } },
    });
    await this.invalidate(...owned.map((o) => o.safetyIdRef.publicToken));
  }

  /** Invalidates the QR currently linked to a helmet (helmet lifecycle / warranty changes). */
  async invalidateForHelmet(helmetId: string): Promise<void> {
    const link = await this.prisma.safetyIdHelmetLink.findFirst({
      where: { helmetId, endedAt: null },
      select: { safetyIdRef: { select: { publicToken: true } } },
    });
    await this.invalidate(link?.safetyIdRef.publicToken);
  }
}
