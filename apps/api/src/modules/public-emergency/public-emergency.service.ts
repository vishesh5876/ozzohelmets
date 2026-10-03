import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  ErrorCode,
  isValidPublicToken,
  type PublicEmergencyDto,
  PublicHelmetState,
  ScanType,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';
import { EmergencyProfileService } from '../emergency/profile/emergency-profile.service';
import {
  FILE_STORAGE_PROVIDER,
  type FileStorageProvider,
  type StoredFile,
} from '../file-storage/file-storage.types';
import {
  type CachedPublicHelmet,
  PublicEmergencyCacheService,
} from '../public-emergency-cache/public-emergency-cache.service';
import { PROFILE_VISIBLE_STATUS, PUBLIC_STATE_MESSAGES, toPublicState } from './public-state';

export interface ScanContext {
  ipHash: string | null;
  userAgent: string | null;
  countryCode: string | null;
}

/**
 * Unauthenticated QR resolution. The response is built by the allow-list sanitizer in the
 * emergency module and contains only owner-approved fields; the filtered result (never raw
 * profile data) is cached briefly and invalidated on every owner change.
 */
@Injectable()
export class PublicEmergencyService {
  private readonly logger = new Logger(PublicEmergencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly profiles: EmergencyProfileService,
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(FILE_STORAGE_PROVIDER) private readonly storage: FileStorageProvider,
  ) {}

  async resolve(token: string, scan: ScanContext): Promise<PublicEmergencyDto> {
    const entry = await this.entry(token);
    this.logScan(entry.helmetId, scan);
    return entry.dto;
  }

  /** Photo is served only while the cached public view says it is visible. */
  async photo(token: string): Promise<StoredFile> {
    const entry = await this.entry(token);
    const file = entry.photo ? await this.storage.get(entry.photo.key) : null;
    if (!file) throw AppException.notFound(ErrorCode.NOT_FOUND, 'No photo available.');
    return file;
  }

  private async entry(token: string): Promise<CachedPublicHelmet> {
    // Cheap rejection before touching cache/DB; same error as unknown tokens (no oracle).
    if (!isValidPublicToken(token)) throw this.notFound();
    let entry = await this.cache.get(token);
    if (!entry) {
      entry = await this.load(token);
      if (!entry) throw this.notFound();
      await this.cache.set(token, entry);
    }
    return entry;
  }

  private async load(token: string): Promise<CachedPublicHelmet | null> {
    const helmet = await this.prisma.helmet.findUnique({
      where: { publicToken: token },
      select: {
        id: true,
        status: true,
        helmetCode: true,
        helmetModel: { select: { name: true, brand: true } },
        ownerships: { where: { status: 'ACTIVE' }, select: { userId: true }, take: 1 },
      },
    });
    if (!helmet) return null;

    const ownerId = helmet.ownerships[0]?.userId ?? null;
    // Decrypt only when the status may show a profile at all (ACTIVE) — and the view itself
    // checks the per-helmet switch of the CURRENT owner, so a previous owner's data can't leak.
    const view =
      ownerId && helmet.status === PROFILE_VISIBLE_STATUS
        ? await this.profiles.publicView(
            ownerId,
            helmet.id,
            `/api/v1/public/emergency/${token}/photo`,
          )
        : null;
    const state = toPublicState(helmet.status, {
      hasOwner: ownerId !== null,
      profilePublishable: view !== null,
    });

    const dto: PublicEmergencyDto = {
      state,
      helmet: { modelName: helmet.helmetModel.name, brand: helmet.helmetModel.brand },
      message: PUBLIC_STATE_MESSAGES[state],
    };
    if (state === PublicHelmetState.ACTIVE && view) {
      dto.helmet.helmetCode = helmet.helmetCode;
      dto.profile = view.data.profile;
      if (view.data.contacts) dto.contacts = view.data.contacts;
      return { helmetId: helmet.id, dto, photo: view.photo };
    }
    return { helmetId: helmet.id, dto, photo: null };
  }

  /**
   * Fire-and-forget scan log. Repeated loads from the same device (IP hash + user agent) within
   * SCAN_DEDUP_SECONDS are counted once, so refreshes don't drown real scans.
   */
  private logScan(helmetId: string, scan: ScanContext): void {
    const dedupSeconds = this.config.get('SCAN_DEDUP_SECONDS');
    const device = createHash('sha256')
      .update(`${scan.ipHash ?? '-'}|${scan.userAgent ?? '-'}`)
      .digest('hex')
      .slice(0, 32);
    const gate =
      dedupSeconds > 0
        ? this.redis
            .set(`scan:dedup:${helmetId}:${device}`, '1', 'EX', dedupSeconds, 'NX')
            .catch(() => 'OK')
        : Promise.resolve('OK');
    void gate
      .then((first) => {
        if (first !== 'OK') return;
        return this.prisma.helmetScan.create({
          data: {
            helmetId,
            scanType: ScanType.EMERGENCY_PAGE,
            ipHash: scan.ipHash,
            userAgent: scan.userAgent,
            countryCode: scan.countryCode,
          },
        });
      })
      .catch((err: Error) => this.logger.warn(`Failed to record scan: ${err.message}`));
  }

  private notFound(): AppException {
    return AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'This QR code is not recognised.');
  }
}
