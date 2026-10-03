import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode, type HelmetModelDto } from '@helmet/types';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type {
  CreateHelmetModelDto,
  HelmetModelQueryDto,
  UpdateHelmetModelDto,
} from './dto/helmet-model.dto';

const withCount = { _count: { select: { helmets: true } } } satisfies Prisma.HelmetModelInclude;
type ModelWithCount = Prisma.HelmetModelGetPayload<{ include: typeof withCount }>;

@Injectable()
export class HelmetModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: HelmetModelQueryDto): Promise<PaginatedResult<HelmetModelDto>> {
    const where: Prisma.HelmetModelWhereInput = {
      status: query.status,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { sku: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helmetModel.findMany({
        where,
        include: withCount,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.helmetModel.count({ where }),
    ]);
    return new PaginatedResult(rows.map(toDto), buildMeta(query.page, query.pageSize, total));
  }

  async get(id: string): Promise<HelmetModelDto> {
    const row = await this.prisma.helmetModel.findUnique({ where: { id }, include: withCount });
    if (!row)
      throw AppException.notFound(ErrorCode.HELMET_MODEL_NOT_FOUND, 'Helmet model not found.');
    return toDto(row);
  }

  async create(
    dto: CreateHelmetModelDto,
    actor: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<HelmetModelDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.helmetModel.create({ data: dto, include: withCount });
        await this.audit.record(
          {
            action: AuditAction.HELMET_MODEL_CREATED,
            entityType: 'helmet_model',
            entityId: row.id,
            adminId: actor.id,
            ipHash: meta.ipHash,
            metadata: { sku: row.sku },
          },
          tx,
        );
        return toDto(row);
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppException.conflict(ErrorCode.CONFLICT, `SKU ${dto.sku} already exists.`);
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateHelmetModelDto,
    actor: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<HelmetModelDto> {
    await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.helmetModel.update({ where: { id }, data: dto, include: withCount });
      await this.audit.record(
        {
          action: AuditAction.HELMET_MODEL_UPDATED,
          entityType: 'helmet_model',
          entityId: id,
          adminId: actor.id,
          ipHash: meta.ipHash,
          metadata: { fields: Object.keys(dto) },
        },
        tx,
      );
      return toDto(row);
    });
  }
}

function toDto(m: ModelWithCount): HelmetModelDto {
  return {
    id: m.id,
    name: m.name,
    sku: m.sku,
    brand: m.brand,
    description: m.description,
    status: m.status,
    helmetCount: m._count.helmets,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}
