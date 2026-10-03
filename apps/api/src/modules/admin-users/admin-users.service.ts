import { Injectable } from '@nestjs/common';
import { type AdminUser } from '@prisma/client';
import { type AdminUserDto, ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { HashingService } from '../../security/hashing.service';
import { AdminTokenService } from '../admin-auth/admin-token.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { CreateAdminUserDto, UpdateAdminUserDto } from './dto/admin-user.dto';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly audit: AuditService,
    private readonly tokens: AdminTokenService,
  ) {}

  async list(): Promise<AdminUserDto[]> {
    const rows = await this.prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toDto);
  }

  async create(
    dto: CreateAdminUserDto,
    actor: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<AdminUserDto> {
    const passwordHash = await this.hashing.hashPassword(dto.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.adminUser.create({
          data: { name: dto.name, email: dto.email, passwordHash, role: dto.role },
        });
        await this.audit.record(
          {
            action: AuditAction.ADMIN_USER_CREATED,
            entityType: 'admin_user',
            entityId: created.id,
            adminId: actor.id,
            ipHash: meta.ipHash,
            metadata: { role: created.role },
          },
          tx,
        );
        return toDto(created);
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppException.conflict(ErrorCode.CONFLICT, 'An admin with this email already exists.');
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateAdminUserDto,
    actor: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<AdminUserDto> {
    if (id === actor.id && (dto.status === 'DISABLED' || (dto.role && dto.role !== actor.role))) {
      throw AppException.forbidden('You cannot disable yourself or change your own role.');
    }
    const existing = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!existing) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Admin user not found.');

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.adminUser.update({
        where: { id },
        data: { name: dto.name, role: dto.role, status: dto.status },
      });
      await this.audit.record(
        {
          action: AuditAction.ADMIN_USER_UPDATED,
          entityType: 'admin_user',
          entityId: id,
          adminId: actor.id,
          ipHash: meta.ipHash,
          metadata: {
            changes: { name: dto.name !== undefined, role: dto.role, status: dto.status },
          },
        },
        tx,
      );
      return row;
    });
    if (dto.status === 'DISABLED' || (dto.role && dto.role !== existing.role)) {
      await this.tokens.revokeAllForAdmin(id);
    }
    return toDto(updated);
  }
}

function toDto(a: AdminUser): AdminUserDto {
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    role: a.role,
    status: a.status,
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}
