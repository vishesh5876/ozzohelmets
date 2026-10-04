import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ErrorCode,
  isValidHelmetCode,
  isValidPublicToken,
  normalizeHelmetCode,
  type ProductReportDetailDto,
  type ProductReportDto,
  type ProductReportPriority,
  type ProductReportStatus,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { CreateProductReportDto } from './dto/product-report.dto';

const HOUR = 3600;

const include = {
  helmet: { select: { id: true, helmetCode: true } },
  reviewedBy: { select: { name: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.ProductReportInclude;

/**
 * Counterfeit-reporting foundation: anonymous, rate-limited submissions stored for review.
 * No automated judgement; reports are never public.
 */
@Injectable()
export class ProductReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: RedisRateLimiter,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async create(dto: CreateProductReportDto, meta: RequestMeta): Promise<{ received: true }> {
    if (meta.ipHash) {
      const r = await this.limiter.hit(
        `product-report:ip:${meta.ipHash}`,
        this.config.get('PRODUCT_REPORTS_PER_IP_PER_HOUR'),
        HOUR,
      );
      if (!r.allowed) {
        throw new AppException(
          ErrorCode.RATE_LIMITED,
          'Too many reports from this network. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
          { retryAfter: r.retryAfter },
        );
      }
    }
    const token = dto.publicToken && isValidPublicToken(dto.publicToken) ? dto.publicToken : null;
    const code = dto.helmetCode ? normalizeHelmetCode(dto.helmetCode) : null;
    const helmet = token
      ? await this.prisma.helmet.findUnique({ where: { publicToken: token }, select: { id: true } })
      : code && isValidHelmetCode(code)
        ? await this.prisma.helmet.findUnique({ where: { helmetCode: code }, select: { id: true } })
        : null;
    const report = await this.prisma.productReport.create({
      data: {
        helmetId: helmet?.id ?? null,
        // A token that doesn't resolve is still useful telemetry (possible copied/forged QR).
        publicToken: token,
        reason: dto.reason,
        description: dto.description ?? null,
        contactEmail: dto.contactEmail?.toLowerCase() ?? null,
        ipHash: meta.ipHash,
      },
    });
    // Free text and contact details stay out of the audit log.
    await this.audit.record({
      action: AuditAction.PRODUCT_REPORT_CREATED,
      entityType: 'product_report',
      entityId: report.id,
      ipHash: meta.ipHash,
      metadata: { reason: dto.reason, helmetId: helmet?.id ?? null, matched: helmet !== null },
    });
    return { received: true };
  }

  async list(
    filter: {
      status?: ProductReportStatus;
      priority?: ProductReportPriority;
      assignee?: 'me' | 'unassigned';
    },
    admin: AuthenticatedAdmin,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<ProductReportDto>> {
    const where: Prisma.ProductReportWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.priority ? { priority: filter.priority } : {}),
      ...(filter.assignee === 'me' ? { assignedAdminId: admin.id } : {}),
      ...(filter.assignee === 'unassigned' ? { assignedAdminId: null } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.productReport.findMany({
        where,
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.productReport.count({ where }),
    ]);
    return new PaginatedResult(rows.map(toDto), buildMeta(page, pageSize, total));
  }

  async detail(id: string): Promise<ProductReportDetailDto> {
    const row = await this.prisma.productReport.findUnique({
      where: { id },
      include: {
        ...include,
        events: {
          orderBy: { createdAt: 'asc' },
          include: { admin: { select: { name: true } } },
        },
      },
    });
    if (!row) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Report not found.');
    return {
      ...toDto(row),
      events: row.events.map((e) => ({
        id: e.id,
        type: e.type,
        fromValue: e.fromValue,
        toValue: e.toValue,
        note: e.note,
        adminName: e.admin?.name ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Triage: status, priority, assignee, resolution note and internal notes. Every change writes
   * an internal event (history), separate from the reporter's public text. Not a ticketing system.
   */
  async update(
    admin: AuthenticatedAdmin,
    id: string,
    input: {
      status?: ProductReportStatus;
      priority?: ProductReportPriority;
      assignedAdminId?: string | null;
      note?: string;
      internalNote?: string;
    },
    meta: RequestMeta,
  ): Promise<ProductReportDetailDto> {
    const existing = await this.prisma.productReport.findUnique({
      where: { id },
      select: { status: true, priority: true, assignedAdminId: true },
    });
    if (!existing) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Report not found.');
    if (input.assignedAdminId) {
      const assignee = await this.prisma.adminUser.findUnique({
        where: { id: input.assignedAdminId },
        select: { status: true },
      });
      if (assignee?.status !== 'ACTIVE')
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Assignee must be an active admin user.',
          HttpStatus.BAD_REQUEST,
        );
    }
    await this.prisma.$transaction(async (tx) => {
      const events: Prisma.ProductReportEventCreateManyInput[] = [];
      const ev = (e: Omit<Prisma.ProductReportEventCreateManyInput, 'reportId' | 'adminId'>) =>
        events.push({ ...e, reportId: id, adminId: admin.id });
      if (input.status && input.status !== existing.status)
        ev({ type: 'STATUS_CHANGED', fromValue: existing.status, toValue: input.status });
      if (input.priority && input.priority !== existing.priority)
        ev({ type: 'PRIORITY_CHANGED', fromValue: existing.priority, toValue: input.priority });
      if (input.assignedAdminId !== undefined && input.assignedAdminId !== existing.assignedAdminId)
        ev({
          type: 'ASSIGNED',
          fromValue: null,
          toValue: input.assignedAdminId ? 'assigned' : 'unassigned',
        });
      if (input.internalNote) ev({ type: 'NOTE', note: input.internalNote });
      await tx.productReport.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status, reviewedByAdminId: admin.id } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.assignedAdminId !== undefined
            ? { assignedAdminId: input.assignedAdminId }
            : {}),
          ...(input.note !== undefined ? { resolutionNote: input.note } : {}),
        },
      });
      if (events.length) await tx.productReportEvent.createMany({ data: events });
      await this.audit.record(
        {
          action:
            input.status && input.status !== existing.status
              ? AuditAction.PRODUCT_REPORT_STATUS_CHANGED
              : AuditAction.PRODUCT_REPORT_NOTE_ADDED,
          entityType: 'product_report',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          // Event types only — never the note text.
          metadata: {
            from: existing.status,
            to: input.status ?? existing.status,
            changes: events.map((e) => e.type),
          },
        },
        tx,
      );
    });
    return this.detail(id);
  }
}

function toDto(r: Prisma.ProductReportGetPayload<{ include: typeof include }>): ProductReportDto {
  return {
    id: r.id,
    reason: r.reason,
    description: r.description,
    contactEmail: r.contactEmail,
    status: r.status,
    helmet: r.helmet,
    resolutionNote: r.resolutionNote,
    reviewedByName: r.reviewedBy?.name ?? null,
    priority: r.priority,
    assignee: r.assignee,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
