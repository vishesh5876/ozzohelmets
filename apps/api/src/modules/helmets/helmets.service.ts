import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  ErrorCode,
  type HelmetDetailDto,
  type HelmetListItemDto,
  type HelmetStatus,
  type HelmetOwnerSummaryDto,
  type HelmetReplacementLinksDto,
  LIFECYCLE_MANAGED_TARGETS,
  maskPhone,
  normalizeHelmetCode,
  Permission,
  roleHasPermission,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { EmergencyReadinessService } from '../emergency-readiness/emergency-readiness.service';
import { helmetProfileStatus, profileStatus } from '../emergency-readiness/readiness';
import { restoreTarget, SUPPORT_RESTORABLE } from '../helmet-lifecycle/domain/lifecycle-policy';
import { HelmetStatusService } from './domain/helmet-status.service';
import type { HelmetQueryDto } from './dto/helmet.dto';

const listSelect = {
  id: true,
  helmetCode: true,
  serialNumber: true,
  status: true,
  activatedAt: true,
  createdAt: true,
  helmetModel: { select: { id: true, name: true, sku: true } },
  batch: { select: { id: true, batchCode: true } },
} satisfies Prisma.HelmetSelect;
type HelmetListRow = Prisma.HelmetGetPayload<{ select: typeof listSelect }>;

@Injectable()
export class HelmetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statuses: HelmetStatusService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly publicCache: PublicEmergencyCacheService,
    private readonly readiness: EmergencyReadinessService,
  ) {}

  async list(query: HelmetQueryDto): Promise<PaginatedResult<HelmetListItemDto>> {
    const where: Prisma.HelmetWhereInput = {
      batchId: query.batchId,
      helmetModelId: query.helmetModelId,
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.activated === true ? { activatedAt: { not: null } } : {}),
      ...(query.activated === false ? { activatedAt: null } : {}),
      ...this.searchFilter(query.search),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helmet.findMany({
        where,
        select: listSelect,
        orderBy: [{ createdAt: 'desc' }, { serialNumber: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.helmet.count({ where }),
    ]);
    return new PaginatedResult(rows.map(toListItem), buildMeta(query.page, query.pageSize, total));
  }

  async get(id: string): Promise<HelmetDetailDto> {
    const helmet = await this.prisma.helmet.findUnique({
      where: { id },
      select: {
        ...listSelect,
        publicToken: true,
        activationPinUsed: true,
        previousOperationalStatus: true,
        updatedAt: true,
        activationSecret: { select: { helmetId: true } },
        _count: { select: { scans: true } },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!helmet) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');

    const adminIds = [
      ...new Set(
        helmet.statusHistory
          .filter((h) => h.actorType === 'ADMIN' && h.actorId)
          .map((h) => h.actorId as string),
      ),
    ];
    const admins = adminIds.length
      ? await this.prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, name: true },
        })
      : [];
    const adminNames = new Map(admins.map((a) => [a.id, a.name]));

    const ownership = await this.prisma.helmetOwnership.findFirst({
      where: { helmetId: id, status: 'ACTIVE' },
      select: {
        activatedAt: true,
        user: { select: { id: true, customerCode: true, mobile: true } },
      },
    });
    const [owner, pending, replacement, restoreTo] = await Promise.all([
      this.ownerSummary(id, ownership),
      this.prisma.helmetTransfer.findFirst({
        where: { helmetId: id, status: 'PENDING', expiresAt: { gt: new Date() } },
        select: { id: true, createdAt: true, expiresAt: true },
      }),
      this.replacementLinks(id),
      ownership && SUPPORT_RESTORABLE.includes(helmet.status)
        ? this.readiness
            .canExpose(ownership.user.id, id)
            .then((ok) => restoreTarget(helmet.previousOperationalStatus, ok))
        : Promise.resolve(null),
    ]);

    return {
      ...toListItem(helmet),
      owner,
      qrUrl: this.config.publicHelmetUrl(helmet.publicToken),
      activationPinUsed: helmet.activationPinUsed,
      pinEscrowed: helmet.activationSecret !== null,
      scanCount: helmet._count.scans,
      // Operational targets are reached only via activation, enablement, transfer or support restore.
      allowedTransitions: this.statuses
        .allowed(helmet.status, ActorType.ADMIN)
        .filter((s) => !LIFECYCLE_MANAGED_TARGETS.includes(s)),
      statusHistory: helmet.statusHistory.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actorType: h.actorType,
        actorName:
          h.actorType === 'ADMIN' && h.actorId ? (adminNames.get(h.actorId) ?? null) : null,
        reason: h.reason,
        createdAt: h.createdAt.toISOString(),
      })),
      pendingTransfer: pending
        ? {
            id: pending.id,
            createdAt: pending.createdAt.toISOString(),
            expiresAt: pending.expiresAt.toISOString(),
          }
        : null,
      replacement,
      restoreTarget: restoreTo,
      updatedAt: helmet.updatedAt.toISOString(),
    };
  }

  /** Admin-initiated lifecycle change; row-locked so concurrent changes serialise. */
  async changeStatus(
    id: string,
    to: HelmetStatus,
    reason: string | undefined,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<HelmetDetailDto> {
    const publicToken = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string; status: HelmetStatus; public_token: string }[]
      >`
        SELECT id, status, public_token FROM helmets WHERE id = ${id}::uuid FOR UPDATE`;
      const helmet = locked[0];
      if (!helmet) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
      if (LIFECYCLE_MANAGED_TARGETS.includes(to)) {
        throw new AppException(
          ErrorCode.INVALID_STATUS_TRANSITION,
          'Operational statuses are set by activation, the owner or the support restore action.',
          HttpStatus.CONFLICT,
          { from: helmet.status, to },
        );
      }
      // Changing a customer-owned helmet is a support action, not a manufacturing one.
      const owned = await tx.helmetOwnership.count({ where: { helmetId: id, status: 'ACTIVE' } });
      if (owned > 0 && !roleHasPermission(admin.role, Permission.HELMET_LIFECYCLE_MANAGE)) {
        throw AppException.forbidden(
          'Changing a customer-owned helmet requires lifecycle permission.',
        );
      }

      await this.statuses.apply(tx, {
        helmetId: id,
        from: helmet.status,
        to,
        actor: { type: ActorType.ADMIN, id: admin.id },
        reason,
      });
      await this.audit.record(
        {
          action: AuditAction.HELMET_STATUS_CHANGED,
          entityType: 'helmet',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { from: helmet.status, to, reason: reason ?? null },
        },
        tx,
      );
      return helmet.public_token;
    });
    await this.publicCache.invalidate(publicToken);
    return this.get(id);
  }

  /**
   * Operational owner info for support: customer id, masked mobile, since-when and the profile
   * status. Admins never see decrypted medical data, names or contacts here.
   */
  private async ownerSummary(
    helmetId: string,
    ownership: {
      activatedAt: Date;
      user: { id: string; customerCode: string; mobile: string | null };
    } | null,
  ): Promise<HelmetOwnerSummaryDto | null> {
    if (!ownership) return null;
    const [facts, enabled] = await Promise.all([
      this.readiness.facts(ownership.user.id),
      this.readiness.helmetEnabled(helmetId, ownership.user.id),
    ]);
    return {
      customerId: ownership.user.customerCode,
      maskedMobile: ownership.user.mobile ? maskPhone(ownership.user.mobile) : null,
      since: ownership.activatedAt.toISOString(),
      emergencyProfileStatus: helmetProfileStatus(profileStatus(facts), enabled),
    };
  }

  private async replacementLinks(helmetId: string): Promise<HelmetReplacementLinksDto> {
    const rows = await this.prisma.helmetReplacement.findMany({
      where: { OR: [{ originalHelmetId: helmetId }, { replacementHelmetId: helmetId }] },
      include: {
        original: { select: { id: true, helmetCode: true } },
        replacement: { select: { id: true, helmetCode: true } },
        createdBy: { select: { name: true } },
      },
    });
    const link = (r: (typeof rows)[number], other: { id: string; helmetCode: string }) => ({
      id: r.id,
      helmetId: other.id,
      helmetCode: other.helmetCode,
      reason: r.reason,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      createdByAdminName: r.createdBy?.name ?? null,
    });
    const by = rows.find((r) => r.originalHelmetId === helmetId);
    const of = rows.find((r) => r.replacementHelmetId === helmetId);
    return {
      replacedBy: by ? link(by, by.replacement) : null,
      replaces: of ? link(of, of.original) : null,
    };
  }

  private searchFilter(search: string | undefined): Prisma.HelmetWhereInput {
    if (!search) return {};
    const exactCode = normalizeHelmetCode(search);
    if (exactCode) return { helmetCode: exactCode };
    const term = search.toUpperCase();
    return {
      OR: [
        { helmetCode: { startsWith: term.startsWith('HM') ? term : `HM-${term}` } },
        { helmetCode: { contains: term } },
        { serialNumber: { contains: term, mode: 'insensitive' } },
      ],
    };
  }
}

function toListItem(h: HelmetListRow): HelmetListItemDto {
  return {
    id: h.id,
    helmetCode: h.helmetCode,
    serialNumber: h.serialNumber,
    status: h.status,
    helmetModel: h.helmetModel,
    batch: h.batch,
    activatedAt: h.activatedAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
  };
}
