import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  ErrorCode,
  isValidPublicToken,
  type PublicEmergencyDto,
  type HelmetStatus,
  type PublicProductVerificationDto,
  PublicProductVerificationState,
  ScanType,
  summarizeUserAgent,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';
import { WarrantyService } from '../warranty/warranty.service';
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
import {
  LIFECYCLE_WARNINGS,
  PROFILE_VISIBLE_STATUSES,
  PUBLIC_STATE_MESSAGES,
  toPublicState,
} from './public-state';
import { PublicAbuseService } from './public-abuse.service';
import { deviceCategory } from '../analytics/domain/device';

/** Public lifecycle summary for the verification page (no personal data). */
const VERIFY_LIFECYCLE: Record<
  HelmetStatus,
  { label: string; warning: string | null; activated: boolean }
> = {
  GENERATED: { label: 'Not yet activated', warning: null, activated: false },
  PRINTED: { label: 'Not yet activated', warning: null, activated: false },
  IN_INVENTORY: { label: 'Not yet activated', warning: null, activated: false },
  SOLD: { label: 'Not yet activated', warning: null, activated: false },
  ACTIVATED: { label: 'In service', warning: null, activated: true },
  ACTIVE: { label: 'In service', warning: null, activated: true },
  LOST: { label: 'Reported lost', warning: 'This helmet has been reported lost.', activated: true },
  STOLEN: {
    label: 'Reported stolen',
    warning: 'This helmet has been reported stolen.',
    activated: true,
  },
  DAMAGED: {
    label: 'Marked as damaged',
    warning: 'This helmet is marked as damaged.',
    activated: true,
  },
  REPLACED: {
    label: 'Replaced',
    warning: 'This helmet has been replaced and is no longer active.',
    activated: true,
  },
  DEACTIVATED: {
    label: 'No longer active',
    warning: 'This helmet is no longer active.',
    activated: true,
  },
  RECALLED: { label: 'Recalled', warning: null, activated: true },
};

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
    private readonly warranties: WarrantyService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(FILE_STORAGE_PROVIDER) private readonly storage: FileStorageProvider,
    private readonly abuse: PublicAbuseService,
  ) {}

  async resolve(token: string, scan: ScanContext): Promise<PublicEmergencyDto> {
    const { entry, cacheHit } = await this.entry(token, scan.ipHash);
    this.logScan(entry.helmetId, scan, ScanType.EMERGENCY_PAGE, cacheHit);
    void this.abuse.recordValidAccess(scan.ipHash, entry.helmetId).catch(() => undefined);
    return entry.dto;
  }

  /**
   * Product authenticity view for the same QR token. Reveals only registry facts (model, SKU,
   * Helmet ID, manufacturing month, batch, lifecycle, coverage) — never owner, medical, PIN,
   * serial or internal ids. An unknown token is "not verified", never "counterfeit".
   */
  async verify(token: string, scan: ScanContext): Promise<PublicProductVerificationDto> {
    const notVerified: PublicProductVerificationDto = {
      state: PublicProductVerificationState.NOT_VERIFIED,
      message: 'We could not verify this Helmet ID. Check the QR code or contact support.',
    };
    if (!isValidPublicToken(token)) {
      await this.abuse.recordMiss(scan.ipHash);
      return notVerified;
    }
    let dto = await this.cache.getVerification(token);
    const cacheHit = dto !== null;
    let helmetId: string | null = null;
    if (!dto) {
      await this.assertUncachedAllowed(scan.ipHash);
      const helmet = await this.prisma.helmet.findUnique({
        where: { publicToken: token },
        select: {
          id: true,
          helmetCode: true,
          status: true,
          qrIntegrityStatus: true,
          helmetModel: { select: { name: true, brand: true, sku: true } },
          batch: { select: { batchCode: true, manufacturingDate: true } },
        },
      });
      if (!helmet) {
        await this.abuse.recordMiss(scan.ipHash);
        return notVerified; // not cached: unknown tokens stay cheap to re-check
      }
      helmetId = helmet.id;
      const lifecycle = VERIFY_LIFECYCLE[helmet.status];
      dto = {
        state: PublicProductVerificationState.VERIFIED,
        message:
          'Product identity verified: this Helmet ID exists in the manufacturer’s registry. This confirms the registered identity, not the physical helmet itself.',
        product: {
          helmetCode: helmet.helmetCode,
          modelName: helmet.helmetModel.name,
          brand: helmet.helmetModel.brand,
          sku: helmet.helmetModel.sku,
          manufactured: helmet.batch.manufacturingDate.toISOString().slice(0, 7),
          batchRef: helmet.batch.batchCode,
        },
        lifecycle: { label: lifecycle.label, warning: lifecycle.warning },
        activated: lifecycle.activated,
        warranty: await this.warranties.publicSummary(helmet.id),
      };
      if (helmet.status === 'RECALLED') dto.recallWarning = LIFECYCLE_WARNINGS.RECALLED;
      // Phase 6: set only by an admin decision — a neutral prompt, never "counterfeit".
      if (helmet.qrIntegrityStatus === 'COMPROMISED')
        dto.integrityNotice =
          'This QR code has been reported as possibly copied. Check that the Helmet ID printed inside the helmet matches the one shown here, and contact support if it does not.';
      await this.cache.setVerification(token, { ...dto, helmetId } as PublicProductVerificationDto);
    } else {
      helmetId = (dto as PublicProductVerificationDto & { helmetId?: string }).helmetId ?? null;
    }
    if (helmetId) {
      this.logScan(helmetId, scan, ScanType.VERIFY, cacheHit);
      void this.abuse.recordValidAccess(scan.ipHash, helmetId).catch(() => undefined);
    }
    const { helmetId: _omit, ...publicDto } = dto as PublicProductVerificationDto & {
      helmetId?: string;
    };
    return publicDto;
  }

  /** Photo is served only while the cached public view says it is visible. */
  async photo(token: string, ipHash: string | null): Promise<StoredFile> {
    const { entry } = await this.entry(token, ipHash);
    const file = entry.photo ? await this.storage.get(entry.photo.key) : null;
    if (!file) throw AppException.notFound(ErrorCode.NOT_FOUND, 'No photo available.');
    return file;
  }

  private async entry(
    token: string,
    ipHash: string | null,
  ): Promise<{ entry: CachedPublicHelmet; cacheHit: boolean }> {
    // Cheap rejection before touching cache/DB; same error as unknown tokens (no oracle).
    if (!isValidPublicToken(token)) {
      await this.abuse.recordMiss(ipHash);
      throw this.notFound();
    }
    let entry = await this.cache.get(token);
    const cacheHit = entry !== null;
    if (!entry) {
      await this.assertUncachedAllowed(ipHash);
      entry = await this.load(token);
      if (!entry) {
        await this.abuse.recordMiss(ipHash);
        throw this.notFound();
      }
      await this.cache.set(token, entry);
    }
    return { entry, cacheHit };
  }

  /** Cached helmets are always served; a flagged IP gets only a small uncached allowance. */
  private async assertUncachedAllowed(ipHash: string | null): Promise<void> {
    if (!(await this.abuse.isFlagged(ipHash))) return;
    const decision = await this.abuse.allowUncached(ipHash);
    if (!decision.allowed)
      throw new AppException(
        ErrorCode.RATE_LIMITED,
        'Too many requests. Please wait a moment and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfter: decision.retryAfter },
      );
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
      ownerId && PROFILE_VISIBLE_STATUSES.includes(helmet.status)
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
    if (view) {
      dto.helmet.helmetCode = helmet.helmetCode;
      dto.profile = view.data.profile;
      if (view.data.contacts) dto.contacts = view.data.contacts;
      const warning = LIFECYCLE_WARNINGS[helmet.status];
      if (warning) {
        // Damaged/recalled helmet still sharing: owner disclaimer + explicit lifecycle warning.
        dto.message = PUBLIC_STATE_MESSAGES.ACTIVE;
        dto.warning = warning;
      }
      return { helmetId: helmet.id, dto, photo: view.photo };
    }
    return { helmetId: helmet.id, dto, photo: null };
  }

  /**
   * Fire-and-forget scan log. Repeated loads from the same device (IP hash + user agent) within
   * SCAN_DEDUP_SECONDS are counted once, so refreshes don't drown real scans.
   */
  /**
   * Fire-and-forget scan log. Repeated loads from the same device (IP hash + user agent) within
   * SCAN_DEDUP_SECONDS are counted once, so refreshes don't drown real scans. Phase 6: only a
   * device category and "Browser on OS" summary are stored (no raw user agent), plus the cache
   * flag. `SCAN_RECORDING_ENABLED=false` keeps dev/test traffic out of analytics.
   */
  private logScan(
    helmetId: string,
    scan: ScanContext,
    scanType: ScanType,
    cacheHit: boolean,
  ): void {
    if (!this.config.get('SCAN_RECORDING_ENABLED')) return;
    const dedupSeconds = this.config.get('SCAN_DEDUP_SECONDS');
    const device = createHash('sha256')
      .update(`${scan.ipHash ?? '-'}|${scan.userAgent ?? '-'}`)
      .digest('hex')
      .slice(0, 32);
    const gate =
      dedupSeconds > 0
        ? this.redis
            .set(`scan:dedup:${scanType}:${helmetId}:${device}`, '1', 'EX', dedupSeconds, 'NX')
            .catch(() => 'OK')
        : Promise.resolve('OK');
    void gate
      .then((first) => {
        if (first !== 'OK') return;
        return this.prisma.helmetScan.create({
          data: {
            helmetId,
            scanType,
            ipHash: scan.ipHash,
            userAgent: summarizeUserAgent(scan.userAgent),
            deviceCategory: deviceCategory(scan.userAgent),
            cacheHit,
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
