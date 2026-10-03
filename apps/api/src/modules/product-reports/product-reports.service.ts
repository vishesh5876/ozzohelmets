import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ErrorCode,
  isValidHelmetCode,
  isValidPublicToken,
  normalizeHelmetCode,
  type ProductReportDto,
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
    status: ProductReportStatus | undefined,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<ProductReportDto>> {
    const where = status ? { status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.productReport.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.productReport.count({ where }),
    ]);
    return new PaginatedResult(rows.map(toDto), buildMeta(page, pageSize, total));
  }

  async update(
    admin: AuthenticatedAdmin,
    id: string,
    status: ProductReportStatus,
    note: string | undefined,
    meta: RequestMeta,
  ): Promise<ProductReportDto> {
    const existing = await this.prisma.productReport.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!existing) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Report not found.');
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.productReport.update({
        where: { id },
        data: {
          status,
          reviewedByAdminId: admin.id,
          ...(note !== undefined ? { resolutionNote: note } : {}),
        },
        include,
      });
      await this.audit.record(
        {
          action: AuditAction.PRODUCT_REPORT_STATUS_CHANGED,
          entityType: 'product_report',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { from: existing.status, to: status },
        },
        tx,
      );
      return updated;
    });
    return toDto(row);
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
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
