import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import type { AuditAction } from './audit-actions';

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  adminId?: string | null;
  userId?: string | null;
  /** Never include secrets, PINs, tokens or medical data. */
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an audit entry. Pass `tx` to make the entry part of the caller's transaction so the
   * audited change and its log commit (or roll back) together.
   */
  async record(entry: AuditEntry, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        adminId: entry.adminId ?? null,
        userId: entry.userId ?? null,
        metadata: (entry.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        ipHash: entry.ipHash ?? null,
      },
    });
  }

  /** Best-effort variant for paths where an audit failure must not fail the request. */
  async recordSafe(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (err) {
      this.logger.error(`Failed to write audit log ${entry.action}: ${(err as Error).message}`);
    }
  }
}
