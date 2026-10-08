import { Injectable, Logger } from '@nestjs/common';
import {
  type AdminSecurityEventDto,
  type CustomerSecurityEventDto,
  type CustomerSecurityEventType,
  SECURITY_EVENT_LABELS,
  summarizeUserAgent,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';

export interface SecurityEventContext {
  sessionId?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Customer-facing security activity. Stores no raw IP (keyed HMAC only), a coarse device summary
 * and never any secret. Writes are best-effort: a failure to record activity must never break
 * sign-in, recovery or activation. Old events are purged after SECURITY_EVENT_RETENTION_DAYS by
 * the worker's `retention.cleanup` job (Phase 6) — the API process schedules nothing.
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Best-effort when outside a transaction; inside one, failures propagate (atomic with it). */
  async record(
    userId: string,
    type: CustomerSecurityEventType,
    ctx: SecurityEventContext = {},
    tx?: PrismaTx,
  ): Promise<void> {
    const data = {
      userId,
      type,
      sessionId: ctx.sessionId ?? null,
      ipHash: ctx.ipHash ?? null,
      userAgentSummary: summarizeUserAgent(ctx.userAgent)?.slice(0, 60) ?? null,
    };
    if (tx) {
      await tx.customerSecurityEvent.create({ data });
      return;
    }
    try {
      await this.prisma.customerSecurityEvent.create({ data });
    } catch (err) {
      this.logger.warn(`Could not record security event ${type}: ${(err as Error).message}`);
    }
  }

  async forCustomer(userId: string, limit = 50): Promise<CustomerSecurityEventDto[]> {
    const rows = await this.prisma.customerSecurityEvent.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      label: SECURITY_EVENT_LABELS[r.type],
      device: r.userAgentSummary,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Admin view (SUPER_ADMIN): no IP hash, no session id — operational facts only. */
  async forAdmin(filter: {
    customerId?: string;
    type?: CustomerSecurityEventType;
    limit?: number;
  }): Promise<AdminSecurityEventDto[]> {
    const rows = await this.prisma.customerSecurityEvent.findMany({
      where: {
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.customerId ? { user: { customerCode: filter.customerId } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
      include: { user: { select: { customerCode: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      label: SECURITY_EVENT_LABELS[r.type],
      customerId: r.user.customerCode,
      device: r.userAgentSummary,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const days = this.config.get('SECURITY_EVENT_RETENTION_DAYS');
    const { count } = await this.prisma.customerSecurityEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - days * DAY_MS) } },
    });
    if (count > 0) this.logger.log(`Purged ${count} security events older than ${days} days`);
    return count;
  }
}
