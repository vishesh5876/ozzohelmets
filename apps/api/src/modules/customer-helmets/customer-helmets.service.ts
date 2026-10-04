import { CustomerAccountService } from '../customer-account/customer-account.service';
import { Injectable } from '@nestjs/common';
import {
  type CustomerDashboardDto,
  type CustomerHelmetDetailDto,
  type CustomerHelmetDto,
  ErrorCode,
  helmetListGroup,
  type HelmetStatus,
  type OwnershipAcquisition,
  ownerActions,
  type StoredWarrantyStatus,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EmergencyReadinessService } from '../emergency-readiness/emergency-readiness.service';
import { helmetProfileStatus, profileStatus } from '../emergency-readiness/readiness';
import { effectiveStatus, isoDate } from '../warranty/domain/warranty-policy';
import { buildTimeline } from './timeline';

function warrantySummary(w: { status: StoredWarrantyStatus; warrantyEndDate: Date } | null) {
  const status = effectiveStatus(w);
  return { status, endDate: w ? isoDate(w.warrantyEndDate) : null };
}

interface OwnedHelmetRow {
  activatedAt: Date;
  acquiredVia: OwnershipAcquisition;
  helmet: {
    id: string;
    helmetCode: string;
    serialNumber: string;
    status: HelmetStatus;
    activatedAt: Date | null;
    publicToken: string;
    helmetModel: { name: string; brand: string };
  };
}

/** Per-listing lookups loaded once (no N+1). */
interface ListContext {
  ownerStatus: ReturnType<typeof profileStatus>;
  switches: Map<string, boolean>;
  pending: Map<string, Date>;
  replacedBy: Map<string, string>;
  replaces: Map<string, string>;
  warranties: Map<string, { status: StoredWarrantyStatus; warrantyEndDate: Date }>;
}

const ownedSelect = {
  activatedAt: true,
  acquiredVia: true,
  helmet: {
    select: {
      id: true,
      helmetCode: true,
      serialNumber: true,
      status: true,
      activatedAt: true,
      publicToken: true,
      helmetModel: { select: { name: true, brand: true } },
    },
  },
} as const;

/**
 * Helmets owned by the authenticated customer. Ownership comes only from an ACTIVE
 * helmet_ownerships row; a helmet the customer doesn't own is indistinguishable from a missing one.
 */
@Injectable()
export class CustomerHelmetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: EmergencyReadinessService,
    private readonly config: AppConfigService,
    private readonly account: CustomerAccountService,
  ) {}

  async list(userId: string): Promise<CustomerHelmetDto[]> {
    const rows = await this.prisma.helmetOwnership.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { activatedAt: 'desc' },
      select: ownedSelect,
    });
    const ctx = await this.context(
      userId,
      rows.map((r) => r.helmet.id),
    );
    return rows.map((row) => this.toDto(row, ctx));
  }

  async get(userId: string, helmetId: string): Promise<CustomerHelmetDto> {
    const row = await this.findOwned(userId, helmetId);
    return this.toDto(row, await this.context(userId, [helmetId]));
  }

  /** Helmet detail with the owner-facing lifecycle timeline (this ownership period only). */
  async detail(userId: string, helmetId: string): Promise<CustomerHelmetDetailDto> {
    const row = await this.findOwned(userId, helmetId);
    const [ctx, history] = await Promise.all([
      this.context(userId, [helmetId]),
      this.prisma.helmetStatusHistory.findMany({
        where: { helmetId, createdAt: { gte: row.activatedAt } },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: { fromStatus: true, toStatus: true, reasonCode: true, createdAt: true },
      }),
    ]);
    return {
      ...this.toDto(row, ctx),
      timeline: buildTimeline(row, history, 'ACTIVATED'),
    };
  }

  /** Public QR URL for one of the customer's own helmets (used for the QR preview). */
  async publicUrl(userId: string, helmetId: string): Promise<string> {
    return this.config.publicHelmetUrl((await this.findOwned(userId, helmetId)).helmet.publicToken);
  }

  async dashboard(userId: string): Promise<CustomerDashboardDto> {
    const [helmets, readiness, contactCount] = await Promise.all([
      this.list(userId),
      this.readiness.readiness(userId),
      this.prisma.emergencyContact.count({ where: { userId, isActive: true } }),
    ]);
    const extras = await this.account.dashboardExtras(userId, helmets, readiness, contactCount);
    return { helmets, readiness, contactCount, ...extras };
  }

  private async findOwned(userId: string, helmetId: string): Promise<OwnedHelmetRow> {
    const row = await this.prisma.helmetOwnership.findFirst({
      where: { userId, helmetId, status: 'ACTIVE' },
      select: ownedSelect,
    });
    if (!row) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    return row;
  }

  private async context(userId: string, helmetIds: string[]): Promise<ListContext> {
    const [facts, switches, pending, links, warranties] = await Promise.all([
      this.readiness.facts(userId),
      this.readiness.helmetSwitches(userId),
      helmetIds.length
        ? this.prisma.helmetTransfer.findMany({
            where: {
              helmetId: { in: helmetIds },
              fromUserId: userId,
              status: 'PENDING',
              expiresAt: { gt: new Date() },
            },
            select: { helmetId: true, expiresAt: true },
          })
        : [],
      helmetIds.length
        ? this.prisma.helmetReplacement.findMany({
            where: {
              OR: [
                { originalHelmetId: { in: helmetIds } },
                { replacementHelmetId: { in: helmetIds } },
              ],
            },
            select: {
              originalHelmetId: true,
              replacementHelmetId: true,
              original: { select: { helmetCode: true } },
              replacement: { select: { helmetCode: true } },
            },
          })
        : [],
      helmetIds.length
        ? this.prisma.helmetWarranty.findMany({
            where: { helmetId: { in: helmetIds } },
            select: { helmetId: true, status: true, warrantyEndDate: true },
          })
        : [],
    ]);
    return {
      ownerStatus: profileStatus(facts),
      switches,
      pending: new Map(pending.map((p) => [p.helmetId, p.expiresAt])),
      replacedBy: new Map(links.map((l) => [l.originalHelmetId, l.replacement.helmetCode])),
      replaces: new Map(links.map((l) => [l.replacementHelmetId, l.original.helmetCode])),
      warranties: new Map(warranties.map((w) => [w.helmetId, w])),
    };
  }

  private toDto(row: OwnedHelmetRow, ctx: ListContext): CustomerHelmetDto {
    const h = row.helmet;
    const enabled = ctx.switches.get(h.id) ?? false;
    const pending = ctx.pending.get(h.id);
    const replacedBy = ctx.replacedBy.get(h.id);
    const replaces = ctx.replaces.get(h.id);
    return {
      id: h.id,
      helmetCode: h.helmetCode,
      serialNumber: h.serialNumber,
      status: h.status,
      model: h.helmetModel,
      activatedAt: h.activatedAt?.toISOString() ?? null,
      ownedSince: row.activatedAt.toISOString(),
      publicUrl: this.config.publicHelmetUrl(h.publicToken),
      emergencyProfileStatus: helmetProfileStatus(ctx.ownerStatus, enabled),
      emergencyEnabled: enabled,
      acquiredVia: row.acquiredVia,
      group: helmetListGroup(h.status),
      availableActions: ownerActions(h.status),
      pendingTransfer: pending ? { expiresAt: pending.toISOString() } : null,
      replacedBy: replacedBy ? { helmetCode: replacedBy } : null,
      replaces: replaces ? { helmetCode: replaces } : null,
      warranty: warrantySummary(ctx.warranties.get(h.id) ?? null),
    };
  }
}
