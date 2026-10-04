import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import {
  type AuditLogDto,
  auditActionLabel,
  normalizeHelmetCode,
  parseAccountIdentifier,
  Permission,
  redactAuditMetadata,
} from '@helmet/types';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { AuditQueryDto } from './dto/audit-query.dto';

@ApiTags('admin / audit')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Filterable audit trail with readable labels. Helmet ID / Customer ID filters are resolved
   * server-side; metadata is redacted (defence in depth — writers never store secrets).
   */
  @Get()
  @AdminAuth(Permission.AUDIT_READ)
  async list(@Query() query: AuditQueryDto): Promise<PaginatedResult<AuditLogDto>> {
    const empty = () => new PaginatedResult([], buildMeta(query.page, query.pageSize, 0));
    let helmetId: string | undefined;
    if (query.helmetCode) {
      const code = normalizeHelmetCode(query.helmetCode);
      const helmet = code
        ? await this.prisma.helmet.findUnique({ where: { helmetCode: code }, select: { id: true } })
        : null;
      if (!helmet) return empty();
      helmetId = helmet.id;
    }
    let userId: string | undefined;
    if (query.customerId) {
      const id = parseAccountIdentifier(query.customerId);
      const user =
        id?.kind === 'customer'
          ? await this.prisma.user.findUnique({
              where: { customerCode: id.code },
              select: { id: true },
            })
          : null;
      if (!user) return empty();
      userId = user.id;
    }
    const actor: Prisma.AuditLogWhereInput =
      query.actorType === 'ADMIN'
        ? { adminId: { not: null } }
        : query.actorType === 'CUSTOMER'
          ? { adminId: null, userId: { not: null } }
          : query.actorType === 'SYSTEM'
            ? { adminId: null, userId: null }
            : {};
    const where: Prisma.AuditLogWhereInput = {
      AND: [
        actor,
        {
          action: query.action,
          entityType: helmetId ? 'helmet' : query.entityType,
          entityId: helmetId ?? query.entityId,
          adminId: query.adminId,
          userId,
          createdAt:
            query.from || query.to
              ? {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lt: new Date(query.to) } : {}),
                }
              : undefined,
        },
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.pageSize,
        include: {
          admin: { select: { id: true, name: true, email: true } },
          user: { select: { customerCode: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const items = rows.map((r): AuditLogDto => ({
      id: r.id,
      action: r.action,
      label: auditActionLabel(r.action),
      actorType: r.adminId ? 'ADMIN' : r.userId ? 'CUSTOMER' : 'SYSTEM',
      entityType: r.entityType,
      entityId: r.entityId,
      admin: r.admin,
      userId: r.userId,
      customerId: r.user?.customerCode ?? null,
      metadata: redactAuditMetadata((r.metadata as Record<string, unknown> | null) ?? null),
      createdAt: r.createdAt.toISOString(),
    }));
    return new PaginatedResult(items, buildMeta(query.page, query.pageSize, total));
  }
}
