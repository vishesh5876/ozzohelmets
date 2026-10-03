import { Injectable } from '@nestjs/common';
import type { EmergencyVisibility } from '@prisma/client';
import type { EmergencyVisibilityDto } from '@helmet/types';
import type { RequestMeta } from '../../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../../infrastructure/prisma/prisma.service';
import type { AuthenticatedCustomer } from '../../customer-auth/customer-auth.types';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit-actions';
import { PublicEmergencyCacheService } from '../../public-emergency-cache/public-emergency-cache.service';
import { DEFAULT_VISIBILITY, type VisibilityFlags } from '../domain/public-profile';
import type { UpdateEmergencyVisibilityDto } from './emergency-visibility.dto';

const FLAG_KEYS = Object.keys(DEFAULT_VISIBILITY) as (keyof VisibilityFlags)[];

@Injectable()
export class EmergencyVisibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly publicCache: PublicEmergencyCacheService,
  ) {}

  async get(userId: string): Promise<EmergencyVisibilityDto> {
    const row = await this.prisma.emergencyVisibility.findUnique({ where: { userId } });
    return { ...this.toFlags(row), confirmedAt: row?.confirmedAt?.toISOString() ?? null };
  }

  /** Visibility flags; everything hidden when the customer never saved a choice. */
  async flags(userId: string, tx?: PrismaTx): Promise<VisibilityFlags> {
    return this.toFlags(
      await (tx ?? this.prisma).emergencyVisibility.findUnique({ where: { userId } }),
    );
  }

  async update(
    customer: AuthenticatedCustomer,
    dto: UpdateEmergencyVisibilityDto,
    meta: RequestMeta,
  ): Promise<EmergencyVisibilityDto> {
    const next = Object.fromEntries(FLAG_KEYS.map((k) => [k, dto[k]])) as VisibilityFlags;
    await this.prisma.$transaction(async (tx) => {
      const before = this.toFlags(
        await tx.emergencyVisibility.findUnique({ where: { userId: customer.id } }),
      );
      await tx.emergencyVisibility.upsert({
        where: { userId: customer.id },
        create: { userId: customer.id, ...next, confirmedAt: new Date() },
        update: { ...next, confirmedAt: new Date() },
      });
      const changed = FLAG_KEYS.filter((k) => before[k] !== next[k]);
      await this.audit.record(
        {
          action: AuditAction.EMERGENCY_VISIBILITY_CHANGED,
          entityType: 'emergency_visibility',
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { changedFlags: changed, publicFlags: FLAG_KEYS.filter((k) => next[k]) },
        },
        tx,
      );
    });
    // Invalidate immediately so a hidden field never outlives the change in the public cache.
    await this.publicCache.invalidateForOwner(customer.id);
    return this.get(customer.id);
  }

  private toFlags(row: EmergencyVisibility | null): VisibilityFlags {
    if (!row) return { ...DEFAULT_VISIBILITY };
    return Object.fromEntries(FLAG_KEYS.map((k) => [k, row[k]])) as VisibilityFlags;
  }
}
