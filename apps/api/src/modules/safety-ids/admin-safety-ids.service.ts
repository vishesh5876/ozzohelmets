import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  type AdminSafetyIdDetailDto,
  type AdminSafetyIdListItemDto,
  ErrorCode,
  normalizeCustomerCode,
  normalizeHelmetCode,
  normalizeSafetyCode,
  type QrIntegrityStatus,
  SAFETY_ID_IN_USE,
  type SafetyIdOwnershipSource,
  type SafetyIdStatus,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RecentAuthService } from '../../security/recent-auth.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { CustomerTokenService } from '../customer-auth/customer-token.service';
import { lastPinExport, pinState } from '../helmets/helmets.service';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { SafetyIdCoreService } from './domain/safety-id-core.service';
import type { AdminSafetyIdQueryDto } from './dto/safety-id.dto';

const listSelect = {
  id: true,
  safetyCode: true,
  status: true,
  qrIntegrityStatus: true,
  activatedAt: true,
  createdAt: true,
  batch: { select: { id: true, batchCode: true } },
  ownerships: {
    where: { status: 'ACTIVE' },
    take: 1,
    select: { userId: true, user: { select: { customerCode: true } } },
  },
  emergencySettings: { where: { enabled: true }, select: { userId: true } },
  helmetLinks: {
    where: { endedAt: null },
    take: 1,
    select: { helmet: { select: { id: true, helmetCode: true } } },
  },
} satisfies Prisma.SafetyIdSelect;

type ListRow = Prisma.SafetyIdGetPayload<{ select: typeof listSelect }>;

function toListItem(r: ListRow): AdminSafetyIdListItemDto {
  const owner = r.ownerships[0] ?? null;
  return {
    id: r.id,
    safetyCode: r.safetyCode,
    status: r.status as SafetyIdStatus,
    emergencySharing: owner ? r.emergencySettings.some((s) => s.userId === owner.userId) : false,
    qrIntegrityStatus: r.qrIntegrityStatus,
    owner: owner ? { customerId: owner.user.customerCode } : null,
    linkedHelmet: r.helmetLinks[0]?.helmet ?? null,
    batch: r.batch,
    activatedAt: r.activatedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Admin view and support actions for Safety IDs. Never returns a PIN or a PIN hash; the public
 * token appears only inside the QR URL (as on the helmet page since Phase 2).
 */
@Injectable()
export class AdminSafetyIdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: SafetyIdCoreService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly config: AppConfigService,
    private readonly recentAuth: RecentAuthService,
    private readonly customerTokens: CustomerTokenService,
  ) {}

  /**
   * One search box: Safety ID, linked Helmet ID, batch code (SID-… / BAT-…) and — with
   * customers:read — the owner's Customer ID. Exact identifiers return one result.
   */
  async list(
    query: AdminSafetyIdQueryDto,
    canSearchCustomers = false,
  ): Promise<PaginatedResult<AdminSafetyIdListItemDto>> {
    const where: Prisma.SafetyIdWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.qrIntegrity ? { qrIntegrityStatus: query.qrIntegrity } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.link === 'linked' ? { helmetLinks: { some: { endedAt: null } } } : {}),
      ...(query.link === 'standalone' ? { helmetLinks: { none: { endedAt: null } } } : {}),
      ...this.searchFilter(query.search, canSearchCustomers),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.safetyId.findMany({
        where,
        select: listSelect,
        orderBy: [{ createdAt: 'desc' }, { safetyCode: 'asc' }],
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.safetyId.count({ where }),
    ]);
    return new PaginatedResult(rows.map(toListItem), buildMeta(query.page, query.pageSize, total));
  }

  private searchFilter(
    raw: string | undefined,
    canSearchCustomers: boolean,
  ): Prisma.SafetyIdWhereInput {
    const term = raw?.trim();
    if (!term) return {};
    const safety = normalizeSafetyCode(term);
    if (safety) return { safetyCode: safety };
    const helmet = normalizeHelmetCode(term);
    if (helmet) return { helmetLinks: { some: { endedAt: null, helmet: { helmetCode: helmet } } } };
    const customer = normalizeCustomerCode(term);
    if (customer)
      return canSearchCustomers
        ? { ownerships: { some: { status: 'ACTIVE', user: { customerCode: customer } } } }
        : { id: { in: [] } };
    const upper = term.toUpperCase();
    return {
      OR: [
        { safetyCode: { startsWith: upper } },
        { batch: { batchCode: { startsWith: upper } } },
        {
          helmetLinks: {
            some: { endedAt: null, helmet: { batch: { batchCode: { startsWith: upper } } } },
          },
        },
      ],
    };
  }

  async get(id: string): Promise<AdminSafetyIdDetailDto> {
    const row = await this.prisma.safetyId.findUnique({
      where: { id },
      select: {
        ...listSelect,
        publicToken: true,
        activationPinUsed: true,
        qrIntegrityNote: true,
        activationSecret: { select: { safetyId: true } },
        helmetLinks: {
          orderBy: { startedAt: 'desc' },
          take: 20,
          select: {
            startedAt: true,
            endedAt: true,
            reason: true,
            helmet: {
              select: {
                id: true,
                helmetCode: true,
                status: true,
                batchId: true,
                helmetModel: { select: { name: true, brand: true } },
              },
            },
          },
        },
        ownerships: {
          orderBy: { startedAt: 'desc' },
          take: 20,
          select: {
            userId: true,
            status: true,
            source: true,
            startedAt: true,
            endedAt: true,
            user: { select: { customerCode: true } },
          },
        },
      },
    });
    if (!row) throw AppException.notFound(ErrorCode.SAFETY_ID_NOT_FOUND, 'Safety ID not found.');
    const current = row.helmetLinks.find((l) => l.endedAt === null)?.helmet ?? null;
    const owner = row.ownerships.find((o) => o.status === 'ACTIVE') ?? null;
    const escrowed = row.activationSecret !== null;
    const [lastExport, scans] = await Promise.all([
      !row.activationPinUsed && escrowed
        ? lastPinExport(this.prisma, current?.batchId ?? null, row.batch?.id ?? null)
        : Promise.resolve(null),
      this.prisma.helmetScan.aggregate({
        where: { safetyId: id, synthetic: false },
        _count: { _all: true },
        _max: { scannedAt: true },
      }),
    ]);
    return {
      id: row.id,
      safetyCode: row.safetyCode,
      status: row.status as SafetyIdStatus,
      emergencySharing: owner
        ? row.emergencySettings.some((s) => s.userId === owner.userId)
        : false,
      qrIntegrityStatus: row.qrIntegrityStatus,
      qrIntegrityNote: row.qrIntegrityNote,
      owner: owner ? { customerId: owner.user.customerCode } : null,
      linkedHelmet: current ? { id: current.id, helmetCode: current.helmetCode } : null,
      linkedHelmetDetail: current
        ? {
            id: current.id,
            helmetCode: current.helmetCode,
            modelName: current.helmetModel.name,
            brand: current.helmetModel.brand,
            status: current.status,
          }
        : null,
      batch: row.batch,
      activatedAt: row.activatedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      qrUrl: this.config.publicHelmetUrl(row.publicToken),
      pinState: pinState(row.activationPinUsed, escrowed, lastExport),
      batchLastExportedAt: lastExport?.toISOString() ?? null,
      scanCount: scans._count._all,
      lastScanAt: scans._max.scannedAt?.toISOString() ?? null,
      linkHistory: row.helmetLinks.map((l) => ({
        helmetCode: l.helmet.helmetCode,
        startedAt: l.startedAt.toISOString(),
        endedAt: l.endedAt?.toISOString() ?? null,
        reason: l.reason,
      })),
      ownershipHistory: row.ownerships.map((o) => ({
        customerId: o.user.customerCode,
        status: o.status,
        source: o.source as SafetyIdOwnershipSource,
        startedAt: o.startedAt.toISOString(),
        endedAt: o.endedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Safety IDs a customer owns (customer page, separate from helmets). */
  async forCustomer(userId: string): Promise<AdminSafetyIdListItemDto[]> {
    const rows = await this.prisma.safetyId.findMany({
      where: { ownerships: { some: { userId, status: 'ACTIVE' } } },
      select: listSelect,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toListItem);
  }

  /**
   * Deactivate (lost sticker, abuse, request): the QR stops showing anyone's information. Owner
   * and history stay; sharing is switched off (and mirrored onto a linked helmet).
   */
  async deactivate(
    admin: AuthenticatedAdmin,
    id: string,
    reason: string,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    await this.recentAuth.assert('admin', admin.id, null, recentAuthToken);
    const token = await this.prisma.$transaction(async (tx) => {
      const state = await this.mustLock(tx, id);
      const { safetyId: sid, ownership } = state;
      if (sid.status === 'DEACTIVATED' || sid.status === 'REPLACED')
        throw AppException.conflict(
          ErrorCode.SAFETY_ID_ACTION_NOT_ALLOWED,
          'This Safety ID is already inactive.',
          { status: sid.status },
        );
      if (ownership)
        await this.core.switchOff(tx, id, ownership.userId, {
          type: ActorType.ADMIN,
          id: admin.id,
        });
      const fresh = await tx.safetyId.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      await this.core.setStatus(tx, id, fresh.status as SafetyIdStatus, 'DEACTIVATED', {
        deactivatedAt: new Date(),
      });
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_DEACTIVATED,
          entityType: 'safety_id',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { from: sid.status, reason },
        },
        tx,
      );
      return sid.publicToken;
    });
    await this.cache.invalidate(token);
    return this.get(id);
  }

  /** Undo a deactivation: back to ACTIVATED (sharing stays off) or PRINTED if never activated. */
  async reactivate(
    admin: AuthenticatedAdmin,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    const token = await this.prisma.$transaction(async (tx) => {
      const { safetyId: sid } = await this.mustLock(tx, id);
      if (sid.status !== 'DEACTIVATED')
        throw AppException.conflict(
          ErrorCode.SAFETY_ID_ACTION_NOT_ALLOWED,
          'Only a deactivated Safety ID can be reactivated.',
          { status: sid.status },
        );
      const to: SafetyIdStatus = sid.activationPinUsed ? 'ACTIVATED' : 'PRINTED';
      await this.core.setStatus(tx, id, 'DEACTIVATED', to, { deactivatedAt: null });
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_REACTIVATED,
          entityType: 'safety_id',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { to, reason },
        },
        tx,
      );
      return sid.publicToken;
    });
    await this.cache.invalidate(token);
    return this.get(id);
  }

  /** Human QR integrity decision (Phase 6 semantics, now on the Safety ID). */
  async setQrIntegrity(
    admin: AuthenticatedAdmin,
    id: string,
    status: QrIntegrityStatus,
    note: string,
    meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    const before = await this.prisma.safetyId.findUnique({
      where: { id },
      select: { qrIntegrityStatus: true, publicToken: true },
    });
    if (!before) throw AppException.notFound(ErrorCode.SAFETY_ID_NOT_FOUND, 'Safety ID not found.');
    await this.prisma.safetyId.update({
      where: { id },
      data: { qrIntegrityStatus: status, qrIntegrityNote: note, qrIntegrityChangedAt: new Date() },
    });
    await this.audit.record({
      action: AuditAction.SAFETY_ID_QR_INTEGRITY_CHANGED,
      entityType: 'safety_id',
      entityId: id,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: { from: before.qrIntegrityStatus, to: status },
    });
    // The verification page shows a neutral notice for COMPROMISED; emergency access is unchanged.
    await this.cache.invalidate(before.publicToken);
    return this.get(id);
  }

  /**
   * Links a Safety ID to a helmet. Both must be free, and they must have the same current owner
   * (or none): linking never hands a product or a QR to someone who hasn't proven possession.
   */
  async link(
    admin: AuthenticatedAdmin,
    id: string,
    rawHelmetCode: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    const helmetCode = normalizeHelmetCode(rawHelmetCode);
    const helmet = helmetCode
      ? await this.prisma.helmet.findUnique({ where: { helmetCode }, select: { id: true } })
      : null;
    if (!helmet) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    let token: string;
    try {
      token = await this.prisma.$transaction(async (tx) => {
        // Lock order: helmet → Safety ID.
        const [h] = await tx.$queryRaw<{ id: string; public_token: string | null }[]>`
          SELECT id, public_token FROM helmets WHERE id = ${helmet.id}::uuid FOR UPDATE`;
        const state = await this.mustLock(tx, id);
        if (state.helmet)
          throw AppException.conflict(
            ErrorCode.SAFETY_ID_LINK_CONFLICT,
            'This Safety ID is already linked to a helmet. Unlink it first.',
          );
        if (await this.core.linkedSafetyId(tx, helmet.id))
          throw AppException.conflict(
            ErrorCode.SAFETY_ID_LINK_CONFLICT,
            'This helmet already has a Safety ID.',
          );
        const helmetOwner = await tx.helmetOwnership.findFirst({
          where: { helmetId: helmet.id, status: 'ACTIVE' },
          select: { userId: true },
        });
        if ((helmetOwner?.userId ?? null) !== (state.ownership?.userId ?? null))
          throw AppException.conflict(
            ErrorCode.SAFETY_ID_LINK_CONFLICT,
            'The Safety ID and the helmet must belong to the same customer (or both to nobody).',
          );
        await this.core.link(tx, id, helmet.id, 'ADMIN_LINK', admin.id);
        if (!h?.public_token)
          await tx.helmet.update({
            where: { id: helmet.id },
            data: {
              publicToken: state.safetyId.publicToken,
              activationPinHash: state.safetyId.activationPinHash,
            },
          });
        await this.audit.record(
          {
            action: AuditAction.SAFETY_ID_LINKED,
            entityType: 'safety_id',
            entityId: id,
            adminId: admin.id,
            ipHash: meta.ipHash,
            metadata: { helmetId: helmet.id, helmetCode, reason },
          },
          tx,
        );
        return state.safetyId.publicToken;
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppException.conflict(
          ErrorCode.SAFETY_ID_LINK_CONFLICT,
          'The Safety ID or the helmet was linked concurrently.',
        );
      throw err;
    }
    await this.cache.invalidate(token);
    return this.get(id);
  }

  /** Ends the current link; the Safety ID keeps its owner and sharing and becomes standalone. */
  async unlink(
    admin: AuthenticatedAdmin,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    const token = await this.prisma.$transaction(async (tx) => {
      const state = await this.mustLock(tx, id);
      if (!state.helmet)
        throw AppException.conflict(
          ErrorCode.SAFETY_ID_ACTION_NOT_ALLOWED,
          'This Safety ID is not linked to a helmet.',
        );
      const helmetId = await this.core.unlink(tx, id);
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_UNLINKED,
          entityType: 'safety_id',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { helmetId, helmetCode: state.helmet.helmetCode, reason },
        },
        tx,
      );
      return state.safetyId.publicToken;
    });
    await this.cache.invalidate(token);
    return this.get(id);
  }

  /** Revokes a STANDALONE Safety ID's owner (linked ones are revoked with their helmet). */
  async revokeOwnership(
    admin: AuthenticatedAdmin,
    id: string,
    reason: string,
    revokeSessions: boolean,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    await this.recentAuth.assert('admin', admin.id, null, recentAuthToken);
    const { token, userId } = await this.prisma.$transaction(async (tx) => {
      const state = await this.mustLock(tx, id);
      if (state.helmet)
        throw new AppException(
          ErrorCode.SAFETY_ID_ACTION_NOT_ALLOWED,
          'This Safety ID is linked to a helmet. Revoke the helmet ownership instead; the Safety ID follows.',
          HttpStatus.CONFLICT,
        );
      if (!state.ownership)
        throw AppException.notFound(ErrorCode.OWNERSHIP_NOT_FOUND, 'This Safety ID has no owner.');
      const now = new Date();
      await tx.safetyIdTransfer.updateMany({
        where: { safetyId: id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'OWNERSHIP_REVOKED' },
      });
      await this.core.endOwnership(tx, id, 'REVOKED', 'ADMIN_REVOKED', now);
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_OWNERSHIP_REVOKED,
          entityType: 'safety_id',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { customerId: state.ownership.userId, reason, sessionsRevoked: revokeSessions },
        },
        tx,
      );
      return { token: state.safetyId.publicToken, userId: state.ownership.userId };
    });
    if (revokeSessions) {
      await this.customerTokens.revokeAll(userId);
      await this.recentAuth.revokeAll('customer', userId);
    }
    await this.cache.invalidate(token);
    return this.get(id);
  }

  /** Counts for the admin dashboard. */
  async metrics(): Promise<{
    total: number;
    standalone: number;
    linked: number;
    activated: number;
    sharing: number;
    compromised: number;
  }> {
    const [byStatus, linked, compromised] = await Promise.all([
      this.prisma.safetyId.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.safetyIdHelmetLink.count({ where: { endedAt: null } }),
      this.prisma.safetyId.count({ where: { qrIntegrityStatus: 'COMPROMISED' } }),
    ]);
    const n = (...s: string[]) =>
      byStatus.filter((r) => s.includes(r.status)).reduce((a, r) => a + r._count._all, 0);
    const total = byStatus.reduce((a, r) => a + r._count._all, 0);
    return {
      total,
      linked,
      standalone: total - linked,
      activated: n(...SAFETY_ID_IN_USE),
      sharing: n('ACTIVE'),
      compromised,
    };
  }

  private async mustLock(tx: Prisma.TransactionClient, id: string) {
    const state = await this.core.lock(tx, { id });
    if (!state) throw AppException.notFound(ErrorCode.SAFETY_ID_NOT_FOUND, 'Safety ID not found.');
    return state;
  }
}
