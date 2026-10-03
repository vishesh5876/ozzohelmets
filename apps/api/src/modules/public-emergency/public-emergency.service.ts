import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode, isValidPublicToken, type PublicEmergencyDto, ScanType } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  type CachedPublicHelmet,
  PublicEmergencyCacheService,
} from './public-emergency-cache.service';
import { PUBLIC_STATE_MESSAGES, toPublicState } from './public-state';

export interface ScanContext {
  ipHash: string | null;
  userAgent: string | null;
  countryCode: string | null;
}

@Injectable()
export class PublicEmergencyService {
  private readonly logger = new Logger(PublicEmergencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PublicEmergencyCacheService,
  ) {}

  async resolve(token: string, scan: ScanContext): Promise<PublicEmergencyDto> {
    // Cheap rejection before touching cache/DB; same error as unknown tokens (no oracle).
    if (!isValidPublicToken(token)) throw this.notFound();

    let entry = await this.cache.get(token);
    if (!entry) {
      entry = await this.load(token);
      if (!entry) throw this.notFound();
      await this.cache.set(token, entry);
    }
    this.logScan(entry.helmetId, scan);
    return entry.dto;
  }

  private async load(token: string): Promise<CachedPublicHelmet | null> {
    const helmet = await this.prisma.helmet.findUnique({
      where: { publicToken: token },
      select: {
        id: true,
        status: true,
        activatedAt: true,
        helmetModel: { select: { name: true, brand: true } },
      },
    });
    if (!helmet) return null;
    const state = toPublicState(helmet.status, helmet.activatedAt !== null);
    return {
      helmetId: helmet.id,
      dto: {
        state,
        helmet: { modelName: helmet.helmetModel.name, brand: helmet.helmetModel.brand },
        message: PUBLIC_STATE_MESSAGES[state],
        profile: null,
      },
    };
  }

  /** Fire-and-forget: scan logging must never slow down or fail an emergency lookup. */
  private logScan(helmetId: string, scan: ScanContext): void {
    this.prisma.helmetScan
      .create({
        data: {
          helmetId,
          scanType: ScanType.EMERGENCY_PAGE,
          ipHash: scan.ipHash,
          userAgent: scan.userAgent,
          countryCode: scan.countryCode,
        },
      })
      .catch((err: Error) => this.logger.warn(`Failed to record scan: ${err.message}`));
  }

  private notFound(): AppException {
    return AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'This QR code is not recognised.');
  }
}
