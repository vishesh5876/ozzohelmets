import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ActorType,
  ErrorCode,
  type HelmetStatus,
  maskPhone,
  type OwnershipPeriodDto,
  type TransferHistoryItemDto,
} from '@helmet/types';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RecentAuthService } from '../../security/recent-auth.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { CustomerTokenService } from '../customer-auth/customer-token.service';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { OwnedHelmetLocker } from '../helmets/domain/owned-helmet.locker';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';

export interface RevokeOwnershipInput {
  reason: string;
  /** ACTIVATED keeps the helmet registered but ownerless; DEACTIVATED retires it. */
  targetStatus: 'ACTIVATED' | 'DEACTIVATED';
  /** Revoke the customer's sessions too (only when account security is affected). */
  revokeSessions?: boolean;
}

/** Support/admin view of ownership history and the exceptional ownership revocation. */
@Injectable()
export class OwnershipAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locker: OwnedHelmetLocker,
    private readonly statuses: HelmetStatusService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly recentAuth: RecentAuthService,
    private readonly customerTokens: CustomerTokenService,
  ) {}

  async history(
    helmetId: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<OwnershipPeriodDto>> {
    await this.assertHelmet(helmetId);
    const where = { helmetId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helmetOwnership.findMany({
        where,
        orderBy: { activatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          acquiredVia: true,
          activatedAt: true,
          endedAt: true,
          endReason: true,
          endedByAdminId: true,
          user: { select: { id: true, mobile: true } },
        },
      }),
      this.prisma.helmetOwnership.count({ where }),
    ]);
    const adminIds = [...new Set(rows.map((r) => r.endedByAdminId).filter(Boolean))] as string[];
    const admins = adminIds.length
      ? await this.prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(admins.map((a) => [a.id, a.name]));
    return new PaginatedResult(
      rows.map((r) => ({
        id: r.id,
        customerId: r.user.id,
        maskedMobile: r.user.mobile ? maskPhone(r.user.mobile) : null,
        status: r.status,
        acquiredVia: r.acquiredVia,
        startedAt: r.activatedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        endReason: r.endReason,
        endedByAdminName: r.endedByAdminId ? (names.get(r.endedByAdminId) ?? null) : null,
      })),
      buildMeta(page, pageSize, total),
    );
  }

  async transfers(
    helmetId: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<TransferHistoryItemDto>> {
    await this.assertHelmet(helmetId);
    const where = { helmetId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helmetTransfer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Never the code hash.
        select: {
          id: true,
          status: true,
          createdAt: true,
          expiresAt: true,
          claimedAt: true,
          cancelledAt: true,
          cancelReason: true,
        },
      }),
      this.prisma.helmetTransfer.count({ where }),
    ]);
    const now = Date.now();
    return new PaginatedResult(
      rows.map((t) => ({
        id: t.id,
        // Expiry is computed, not swept: a PENDING row past its expiry is reported as EXPIRED.
        status: t.status === 'PENDING' && t.expiresAt.getTime() <= now ? 'EXPIRED' : t.status,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
        claimedAt: t.claimedAt?.toISOString() ?? null,
        cancelledAt: t.cancelledAt?.toISOString() ?? null,
        cancelReason: t.cancelReason,
      })),
      buildMeta(page, pageSize, total),
    );
  }

  /**
   * Exceptional: ends the current ownership. Requires a recent admin password confirmation and a
   * reason. The helmet is NOT made claimable by anyone else (its PIN is consumed); re-assignment
   * is a separate, deliberate process.
   */
  async revoke(
    admin: AuthenticatedAdmin,
    helmetId: string,
    input: RevokeOwnershipInput,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.recentAuth.assert('admin', admin.id, null, recentAuthToken);
    const { publicToken, userId } = await this.prisma.$transaction(async (tx) => {
      const locked = await this.locker.lock(tx, { id: helmetId });
      if (!locked) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
      const { helmet, ownership } = locked;
      if (!ownership) {
        const last = await tx.helmetOwnership.findFirst({
          where: { helmetId },
          orderBy: { activatedAt: 'desc' },
          select: { status: true },
        });
        throw last?.status === 'REVOKED'
          ? AppException.conflict(
              ErrorCode.OWNERSHIP_ALREADY_REVOKED,
              'Ownership was already revoked.',
            )
          : AppException.notFound(
              ErrorCode.OWNERSHIP_NOT_FOUND,
              'This helmet has no current owner.',
            );
      }
      const now = new Date();
      await tx.helmetOwnership.update({
        where: { id: ownership.id },
        data: {
          status: 'REVOKED',
          endedAt: now,
          endReason: 'ADMIN_REVOKED',
          endedByAdminId: admin.id,
        },
      });
      await tx.helmetTransfer.updateMany({
        where: { helmetId, status: 'PENDING' },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelReason: 'OWNERSHIP_REVOKED',
          cancelledByAdminId: admin.id,
        },
      });
      await tx.helmetEmergencySetting.updateMany({
        where: { helmetId, userId: ownership.userId },
        data: { enabled: false },
      });
      // A replaced helmet stays REPLACED (final); otherwise move to the requested safe state.
      if (helmet.status !== input.targetStatus && helmet.status !== 'REPLACED') {
        await this.statuses.apply(tx, {
          helmetId,
          from: helmet.status,
          to: input.targetStatus as HelmetStatus,
          actor: { type: ActorType.ADMIN, id: admin.id },
          reason: input.reason,
          reasonCode: 'OWNERSHIP_REVOKED',
        });
      }
      await this.audit.record(
        {
          action: AuditAction.OWNERSHIP_REVOKED,
          entityType: 'helmet',
          entityId: helmetId,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: {
            ownershipId: ownership.id,
            customerId: ownership.userId,
            fromStatus: helmet.status,
            targetStatus: input.targetStatus,
            reason: input.reason,
            sessionsRevoked: input.revokeSessions === true,
          },
        },
        tx,
      );
      return { publicToken: helmet.publicToken, userId: ownership.userId };
    });
    if (input.revokeSessions) {
      await this.customerTokens.revokeAll(userId);
      await this.recentAuth.revokeAll('customer', userId);
    }
    await this.cache.invalidate(publicToken);
  }

  private async assertHelmet(helmetId: string): Promise<void> {
    const exists = await this.prisma.helmet.count({ where: { id: helmetId } });
    if (!exists) {
      throw new AppException(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.', HttpStatus.NOT_FOUND);
    }
  }
}
