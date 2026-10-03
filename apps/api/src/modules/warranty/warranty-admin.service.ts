import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  type AdminWarrantyDetailDto,
  type AdminWarrantyListItemDto,
  type CorrectWarrantyRequest,
  ErrorCode,
  normalizeCustomerCode,
  normalizeHelmetCode,
  type WarrantyStatus,
  type WarrantyVoidReason,
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
import {
  FILE_STORAGE_PROVIDER,
  type FileStorageProvider,
  type StoredFile,
} from '../file-storage/file-storage.types';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import {
  coverage,
  effectiveStatus,
  isoDate,
  toDate,
  todayUtc,
  WarrantyPolicyService,
} from './domain/warranty-policy';
import { summary, WarrantyService } from './warranty.service';

const listInclude = {
  helmet: {
    select: {
      id: true,
      helmetCode: true,
      serialNumber: true,
      publicToken: true,
      helmetModel: { select: { name: true, warrantyMonths: true } },
      batch: { select: { manufacturingDate: true } },
      ownerships: {
        where: { status: 'ACTIVE' as const },
        take: 1,
        select: { user: { select: { customerCode: true } } },
      },
    },
  },
} satisfies Prisma.HelmetWarrantyInclude;
type ListRow = Prisma.HelmetWarrantyGetPayload<{ include: typeof listInclude }>;

export interface WarrantyListQuery {
  search?: string;
  status?: WarrantyStatus;
  page: number;
  pageSize: number;
}

/**
 * Support/admin warranty operations. Corrections, voids and restores never overwrite silently:
 * every change writes warranty history (dates old → new; other fields by name only) and an audit
 * entry. There is no delete.
 */
@Injectable()
export class WarrantyAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly warranties: WarrantyService,
    private readonly policy: WarrantyPolicyService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly recentAuth: RecentAuthService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly storage: FileStorageProvider,
  ) {}

  async list(q: WarrantyListQuery): Promise<PaginatedResult<AdminWarrantyListItemDto>> {
    const where: Prisma.HelmetWarrantyWhereInput = {
      ...this.statusFilter(q.status),
      ...this.searchFilter(q.search),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helmetWarranty.findMany({
        where,
        include: listInclude,
        orderBy: { registeredAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.helmetWarranty.count({ where }),
    ]);
    return new PaginatedResult(rows.map(toListItem), buildMeta(q.page, q.pageSize, total));
  }

  async detail(id: string): Promise<AdminWarrantyDetailDto> {
    const w = await this.prisma.helmetWarranty.findUnique({
      where: { id },
      include: {
        ...listInclude,
        registeredBy: { select: { customerCode: true } },
        replacementOf: { select: { helmet: { select: { helmetCode: true } } } },
        replacedBy: { select: { helmet: { select: { helmetCode: true } } } },
        history: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    if (!w) throw AppException.notFound(ErrorCode.WARRANTY_NOT_FOUND, 'Warranty not found.');
    const adminIds = [
      ...new Set(
        w.history.filter((h) => h.actorType === 'ADMIN' && h.actorId).map((h) => h.actorId!),
      ),
    ];
    const admins = adminIds.length
      ? await this.prisma.adminUser.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(admins.map((a) => [a.id, a.name]));
    return {
      ...toListItem(w),
      registeredByCustomerId: w.registeredBy?.customerCode ?? null,
      purchaseChannel: w.purchaseChannel,
      sellerName: w.sellerName,
      sellerCity: w.sellerCity,
      notes: w.notes,
      hasProof: w.proofKey !== null,
      proofContentType: w.proofContentType,
      proofUploadedAt: w.proofUploadedAt?.toISOString() ?? null,
      voidReason: w.voidReason,
      voidedAt: w.voidedAt?.toISOString() ?? null,
      replacementOf: w.replacementOf ? { helmetCode: w.replacementOf.helmet.helmetCode } : null,
      replacedBy: w.replacedBy ? { helmetCode: w.replacedBy.helmet.helmetCode } : null,
      history: w.history.map((h) => ({
        id: h.id,
        event: h.event,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actorType: h.actorType,
        actorName: h.actorType === 'ADMIN' && h.actorId ? (names.get(h.actorId) ?? null) : null,
        reasonCode: h.reasonCode,
        note: h.note,
        changes: (h.changes as Record<string, unknown> | null) ?? null,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  }

  /** Field corrections with a mandatory reason. Changing the purchase date recomputes coverage
   *  from the model policy unless explicit start/end dates are given. */
  async correct(
    admin: AuthenticatedAdmin,
    id: string,
    dto: CorrectWarrantyRequest,
    meta: RequestMeta,
  ): Promise<AdminWarrantyDetailDto> {
    const token = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM helmet_warranties WHERE id = ${id}::uuid FOR UPDATE`;
      const w = await tx.helmetWarranty.findUnique({ where: { id }, include: listInclude });
      if (!w) throw AppException.notFound(ErrorCode.WARRANTY_NOT_FOUND, 'Warranty not found.');

      const purchaseDate = dto.purchaseDate ? toDate(dto.purchaseDate) : w.purchaseDate;
      if (dto.purchaseDate)
        this.policy.assertPurchaseDate(purchaseDate, w.helmet.batch.manufacturingDate);
      let start = dto.startDate ? toDate(dto.startDate) : w.warrantyStartDate;
      let end = dto.endDate ? toDate(dto.endDate) : w.warrantyEndDate;
      if (
        dto.purchaseDate &&
        !dto.startDate &&
        !dto.endDate &&
        w.registrationSource !== 'REPLACEMENT'
      ) {
        ({ start, end } = coverage(purchaseDate, w.helmet.helmetModel.warrantyMonths));
      }
      if (purchaseDate > start || start > end) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Dates must satisfy purchase ≤ start ≤ end.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const changes: Record<string, unknown> = {};
      const dateChange = (k: string, from: Date, to: Date) => {
        if (isoDate(from) !== isoDate(to)) changes[k] = { from: isoDate(from), to: isoDate(to) };
      };
      dateChange('purchaseDate', w.purchaseDate, purchaseDate);
      dateChange('startDate', w.warrantyStartDate, start);
      dateChange('endDate', w.warrantyEndDate, end);
      const datesChanged = Object.keys(changes).length > 0;
      // Free-text fields: names only (values may be personal/commercial data).
      const fields = (['purchaseChannel', 'sellerName', 'invoiceNumber'] as const).filter(
        (k) => dto[k] !== undefined && dto[k] !== w[k],
      );
      if (fields.length) changes.fields = fields;
      if (!Object.keys(changes).length) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Nothing to change.',
          HttpStatus.BAD_REQUEST,
        );
      }

      await tx.helmetWarranty.update({
        where: { id },
        data: {
          purchaseDate,
          warrantyStartDate: start,
          warrantyEndDate: end,
          ...(dto.purchaseChannel !== undefined ? { purchaseChannel: dto.purchaseChannel } : {}),
          ...(dto.sellerName !== undefined ? { sellerName: dto.sellerName } : {}),
          ...(dto.invoiceNumber !== undefined ? { invoiceNumber: dto.invoiceNumber } : {}),
        },
      });
      await this.warranties.history(tx, id, {
        event: datesChanged ? 'DATE_CORRECTED' : 'ADMIN_UPDATED',
        fromStatus: w.status,
        toStatus: w.status,
        actorType: ActorType.ADMIN,
        actorId: admin.id,
        reasonCode: dto.reasonCode,
        note: dto.note ?? null,
        changes,
      });
      await this.audit.record(
        {
          action: AuditAction.WARRANTY_UPDATED,
          entityType: 'warranty',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { reasonCode: dto.reasonCode, changes },
        },
        tx,
      );
      return w.helmet.publicToken;
    });
    await this.cache.invalidate(token);
    return this.detail(id);
  }

  /** Explicit admin decision (never inferred); requires a recent password confirmation. */
  async voidWarranty(
    admin: AuthenticatedAdmin,
    id: string,
    reason: WarrantyVoidReason,
    note: string | undefined,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<AdminWarrantyDetailDto> {
    await this.recentAuth.assert('admin', admin.id, null, recentAuthToken);
    return this.transition(admin, id, meta, {
      allowedFrom: ['ACTIVE', 'EXPIRED'],
      to: 'VOID',
      event: 'VOIDED',
      reasonCode: reason,
      note,
      data: { status: 'VOID', voidReason: reason, voidedAt: new Date() },
      audit: AuditAction.WARRANTY_VOIDED,
    });
  }

  /** Undo a mistaken void. */
  async restore(
    admin: AuthenticatedAdmin,
    id: string,
    note: string | undefined,
    meta: RequestMeta,
  ): Promise<AdminWarrantyDetailDto> {
    return this.transition(admin, id, meta, {
      allowedFrom: ['VOID'],
      to: 'ACTIVE',
      event: 'RESTORED',
      reasonCode: 'VOID_REVERSED',
      note,
      data: { status: 'ACTIVE', voidReason: null, voidedAt: null },
      audit: AuditAction.WARRANTY_RESTORED,
    });
  }

  /** Permission-gated, audited access to a private proof-of-purchase document. */
  async proof(admin: AuthenticatedAdmin, id: string, meta: RequestMeta): Promise<StoredFile> {
    const w = await this.prisma.helmetWarranty.findUnique({
      where: { id },
      select: { proofKey: true, helmetId: true },
    });
    const file = w?.proofKey ? await this.storage.get(w.proofKey) : null;
    if (!w || !file) {
      throw AppException.notFound(
        ErrorCode.WARRANTY_PROOF_NOT_FOUND,
        'No proof of purchase uploaded.',
      );
    }
    await this.audit.record({
      action: AuditAction.WARRANTY_PROOF_VIEWED,
      entityType: 'warranty',
      entityId: id,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: { helmetId: w.helmetId },
    });
    return file;
  }

  private async transition(
    admin: AuthenticatedAdmin,
    id: string,
    meta: RequestMeta,
    t: {
      allowedFrom: ('ACTIVE' | 'EXPIRED' | 'VOID')[];
      to: 'ACTIVE' | 'VOID';
      event: 'VOIDED' | 'RESTORED';
      reasonCode: string;
      note?: string;
      data: Prisma.HelmetWarrantyUpdateInput;
      audit: AuditAction;
    },
  ): Promise<AdminWarrantyDetailDto> {
    const token = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM helmet_warranties WHERE id = ${id}::uuid FOR UPDATE`;
      const w = await tx.helmetWarranty.findUnique({
        where: { id },
        select: { status: true, helmet: { select: { publicToken: true } } },
      });
      if (!w) throw AppException.notFound(ErrorCode.WARRANTY_NOT_FOUND, 'Warranty not found.');
      if (!(t.allowedFrom as string[]).includes(w.status)) {
        throw AppException.conflict(
          ErrorCode.WARRANTY_INVALID_STATE,
          `This warranty is ${w.status} and can’t be changed this way.`,
          { status: w.status },
        );
      }
      await tx.helmetWarranty.update({ where: { id }, data: t.data });
      await this.warranties.history(tx, id, {
        event: t.event,
        fromStatus: w.status,
        toStatus: t.to,
        actorType: ActorType.ADMIN,
        actorId: admin.id,
        reasonCode: t.reasonCode,
        note: t.note ?? null,
      });
      await this.audit.record(
        {
          action: t.audit,
          entityType: 'warranty',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { from: w.status, to: t.to, reasonCode: t.reasonCode },
        },
        tx,
      );
      return w.helmet.publicToken;
    });
    await this.cache.invalidate(token);
    return this.detail(id);
  }

  private statusFilter(status?: WarrantyStatus): Prisma.HelmetWarrantyWhereInput {
    const today = todayUtc();
    switch (status) {
      case undefined:
      case 'NOT_REGISTERED':
        return {};
      case 'ACTIVE':
        return { status: { in: ['ACTIVE', 'EXPIRED'] }, warrantyEndDate: { gte: today } };
      case 'EXPIRED':
        return { status: { in: ['ACTIVE', 'EXPIRED'] }, warrantyEndDate: { lt: today } };
      default:
        return { status };
    }
  }

  private searchFilter(search?: string): Prisma.HelmetWarrantyWhereInput {
    if (!search?.trim()) return {};
    const term = search.trim();
    const customer = normalizeCustomerCode(term);
    if (customer) {
      return {
        OR: [
          { registeredBy: { customerCode: customer } },
          {
            helmet: {
              ownerships: { some: { status: 'ACTIVE', user: { customerCode: customer } } },
            },
          },
        ],
      };
    }
    const helmetCode = normalizeHelmetCode(term);
    if (helmetCode && term.toUpperCase().startsWith('HM')) return { helmet: { helmetCode } };
    return {
      OR: [
        { helmet: { helmetCode: { contains: term.toUpperCase() } } },
        { helmet: { serialNumber: { contains: term, mode: 'insensitive' } } },
        { invoiceNumber: { equals: term, mode: 'insensitive' } },
      ],
    };
  }
}

function toListItem(w: ListRow): AdminWarrantyListItemDto {
  return {
    ...summary(w, effectiveStatus(w)),
    id: w.id,
    helmet: {
      id: w.helmet.id,
      helmetCode: w.helmet.helmetCode,
      serialNumber: w.helmet.serialNumber,
      modelName: w.helmet.helmetModel.name,
    },
    ownerCustomerId: w.helmet.ownerships[0]?.user.customerCode ?? null,
    invoiceNumber: w.invoiceNumber,
  };
}
