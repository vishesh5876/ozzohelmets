import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { type AuditLogDto, Permission } from '@helmet/types';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { AuditQueryDto } from './dto/audit-query.dto';

@ApiTags('admin / audit')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @AdminAuth(Permission.AUDIT_READ)
  async list(@Query() query: AuditQueryDto): Promise<PaginatedResult<AuditLogDto>> {
    const where: Prisma.AuditLogWhereInput = {
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      adminId: query.adminId,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.pageSize,
        include: { admin: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const items = rows.map((r): AuditLogDto => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      admin: r.admin,
      userId: r.userId,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return new PaginatedResult(items, buildMeta(query.page, query.pageSize, total));
  }
}
