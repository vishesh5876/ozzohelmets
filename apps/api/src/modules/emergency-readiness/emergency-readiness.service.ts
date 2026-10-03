import { HttpStatus, Injectable } from '@nestjs/common';
import { type EmergencyProfileStatus, type EmergencyReadinessDto, ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import {
  evaluateReadiness,
  missingRequirements,
  profileStatus,
  type ReadinessFacts,
} from './readiness';

/** Loads readiness facts for a customer and applies the rules in `readiness.ts`. */
@Injectable()
export class EmergencyReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async facts(userId: string, tx?: PrismaTx): Promise<ReadinessFacts> {
    const db = tx ?? this.prisma;
    const [profile, contacts, visibility, owned] = await Promise.all([
      db.emergencyProfile.findFirst({
        where: { userId, helmetId: null },
        select: { name: true, emergencyProfileEnabled: true },
      }),
      db.emergencyContact.count({ where: { userId, isActive: true } }),
      db.emergencyVisibility.findUnique({ where: { userId }, select: { confirmedAt: true } }),
      db.helmetOwnership.count({ where: { userId, status: 'ACTIVE' } }),
    ]);
    return {
      ownsHelmet: owned > 0,
      hasProfile: profile !== null,
      name: profile?.name ?? null,
      activeContactCount: contacts,
      privacyConfirmed: visibility?.confirmedAt != null,
      enabled: profile?.emergencyProfileEnabled ?? false,
    };
  }

  async readiness(userId: string): Promise<EmergencyReadinessDto> {
    return evaluateReadiness(await this.facts(userId));
  }

  async status(userId: string): Promise<EmergencyProfileStatus> {
    return profileStatus(await this.facts(userId));
  }

  /** Throws PROFILE_INCOMPLETE (with the missing requirements) unless the profile may be enabled. */
  async assertCanEnable(userId: string, tx?: PrismaTx): Promise<void> {
    const missing = missingRequirements(await this.facts(userId, tx));
    if (missing.length > 0) {
      throw new AppException(
        ErrorCode.PROFILE_INCOMPLETE,
        'Complete the required emergency information before enabling.',
        HttpStatus.CONFLICT,
        { missing },
      );
    }
  }

  /**
   * While the profile is enabled, edits must not break a requirement (e.g. deleting the last
   * contact). Call inside the editing transaction after applying the change.
   */
  async assertStillValidIfEnabled(userId: string, tx: PrismaTx): Promise<void> {
    const facts = await this.facts(userId, tx);
    if (!facts.enabled) return;
    const missing = missingRequirements(facts);
    if (missing.length > 0) {
      throw new AppException(
        ErrorCode.PROFILE_REQUIREMENT,
        'Your emergency profile is enabled and needs this information. Disable the profile first, or add a replacement.',
        HttpStatus.CONFLICT,
        { missing },
      );
    }
  }
}
