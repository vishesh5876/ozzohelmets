import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma, RiskAlert } from '@prisma/client';
import {
  type CursorPage,
  ErrorCode,
  OPEN_RISK_ALERT_STATUSES,
  RISK_ALERT_LABELS,
  type RiskAlertDto,
  type RiskAlertStatus,
  type RiskAlertType,
  type RiskLevel,
  type RiskReasonDto,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { decodeCursor, encodeCursor } from './domain/cursor';
import { maxLevel } from './domain/risk-rules';

export interface RaiseAlertInput {
  type: RiskAlertType;
  dedupKey: string;
  priority: RiskLevel;
  summary: string;
  helmetId?: string;
  sourceRef?: string;
  reasons?: RiskReasonDto[];
  observedValue?: number;
  thresholdValue?: number;
}

/** Opaque, non-reversible reference for a request source (never the IP or IP hash itself). */
export function sourceRefFor(ipHash: string): string {
  return createHash('sha256').update(`risk-source:${ipHash}`).digest('hex').slice(0, 12);
}

const include = {
  helmet: { select: { id: true, helmetCode: true } },
  assignee: { select: { id: true, name: true } },
  resolvedBy: { select: { name: true } },
} satisfies Prisma.RiskAlertInclude;
type AlertRow = Prisma.RiskAlertGetPayload<{ include: typeof include }>;

/** Allowed manual status changes. RESOLVED / DISMISSED are final (a new alert may open later). */
const NEXT: Record<RiskAlertStatus, readonly RiskAlertStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'],
  ACKNOWLEDGED: ['INVESTIGATING', 'RESOLVED', 'DISMISSED'],
  INVESTIGATING: ['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
};

export function canMoveAlert(from: RiskAlertStatus, to: RiskAlertStatus): boolean {
  return NEXT[from].includes(to);
}

/**
 * Operational alerts with deduplication: one open alert per dedup key (partial unique index);
 * new observations update it. After a human resolves or dismisses an alert, the same key stays
 * quiet for RISK_ALERT_SUPPRESS_HOURS unless the observed value at least doubles.
 */
@Injectable()
export class RiskAlertsService {
  private readonly logger = new Logger(RiskAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Returns the open alert (created or updated), or null when suppressed. */
  async raise(input: RaiseAlertInput, now = new Date()): Promise<RiskAlert | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const open = await this.prisma.riskAlert.findFirst({
        where: { dedupKey: input.dedupKey, status: { in: [...OPEN_RISK_ALERT_STATUSES] } },
      });
      if (open) {
        return this.prisma.riskAlert.update({
          where: { id: open.id },
          data: {
            lastSeenAt: now,
            occurrences: { increment: 1 },
            priority: maxLevel(open.priority, input.priority),
            summary: input.summary,
            reasons: (input.reasons ?? []) as unknown as Prisma.InputJsonValue,
            observedValue: Math.max(open.observedValue ?? 0, input.observedValue ?? 0),
            thresholdValue: input.thresholdValue ?? open.thresholdValue,
          },
        });
      }
      const suppressHours = this.config.get('RISK_ALERT_SUPPRESS_HOURS');
      if (suppressHours > 0) {
        const closed = await this.prisma.riskAlert.findFirst({
          where: {
            dedupKey: input.dedupKey,
            status: { in: ['RESOLVED', 'DISMISSED'] },
            resolvedAt: { gt: new Date(now.getTime() - suppressHours * 3_600_000) },
          },
          orderBy: { resolvedAt: 'desc' },
        });
        if (closed && (input.observedValue ?? 0) < 2 * (closed.observedValue ?? 0)) return null;
      }
      try {
        return await this.prisma.riskAlert.create({
          data: {
            type: input.type,
            dedupKey: input.dedupKey,
            priority: input.priority,
            summary: input.summary,
            helmetId: input.helmetId ?? null,
            sourceRef: input.sourceRef ?? null,
            reasons: (input.reasons ?? []) as unknown as Prisma.InputJsonValue,
            observedValue: input.observedValue ?? null,
            thresholdValue: input.thresholdValue ?? null,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });
      } catch (err) {
        // A concurrent raise created it first: loop once and update that one.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return null;
  }

  /** Fire-and-forget variant for request paths: never throws, never slows the response. */
  raiseSafe(input: RaiseAlertInput): void {
    void this.raise(input).catch((err: Error) =>
      this.logger.warn(`Could not raise ${input.type} alert: ${err.message}`),
    );
  }

  async list(filter: {
    status?: RiskAlertStatus | 'OPEN_ANY';
    type?: RiskAlertType;
    helmetId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<RiskAlertDto>> {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const after = decodeCursor(filter.cursor);
    const where: Prisma.RiskAlertWhereInput = {
      ...(filter.status === 'OPEN_ANY'
        ? { status: { in: [...OPEN_RISK_ALERT_STATUSES] } }
        : filter.status
          ? { status: filter.status }
          : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.helmetId ? { helmetId: filter.helmetId } : {}),
      // Keyset pagination on (lastSeenAt, id) descending.
      ...(after
        ? {
            OR: [
              { lastSeenAt: { lt: new Date(after.t) } },
              { lastSeenAt: new Date(after.t), id: { lt: after.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.riskAlert.findMany({
      where,
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toAlertDto),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ t: last.lastSeenAt.toISOString(), id: last.id })
          : null,
    };
  }

  async get(id: string): Promise<RiskAlertDto> {
    const row = await this.prisma.riskAlert.findUnique({ where: { id }, include });
    if (!row) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Alert not found.');
    return toAlertDto(row);
  }

  /** Human workflow: status, assignee, resolution reason. Audited (never on every scan). */
  async update(
    admin: AuthenticatedAdmin,
    id: string,
    input: { status?: RiskAlertStatus; assignedAdminId?: string | null; resolutionReason?: string },
    meta: RequestMeta,
  ): Promise<RiskAlertDto> {
    const alert = await this.prisma.riskAlert.findUnique({ where: { id } });
    if (!alert) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Alert not found.');
    const closing = input.status === 'RESOLVED' || input.status === 'DISMISSED';
    if (input.status && input.status !== alert.status && !canMoveAlert(alert.status, input.status))
      throw new AppException(
        ErrorCode.INVALID_STATUS_CHANGE,
        `An alert that is ${alert.status.toLowerCase()} cannot become ${input.status.toLowerCase()}.`,
        HttpStatus.CONFLICT,
      );
    if (closing && !input.resolutionReason?.trim())
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'A resolution reason is required to resolve or dismiss an alert.',
        HttpStatus.BAD_REQUEST,
      );
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
    const now = new Date();
    const { count } = await this.prisma.riskAlert.updateMany({
      where: { id, status: alert.status },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.assignedAdminId !== undefined ? { assignedAdminId: input.assignedAdminId } : {}),
        ...(closing
          ? {
              resolutionReason: input.resolutionReason!.trim(),
              resolvedAt: now,
              resolvedByAdminId: admin.id,
            }
          : {}),
      },
    });
    if (count !== 1)
      throw AppException.conflict(ErrorCode.CONFLICT, 'The alert changed meanwhile. Reload.');
    if (closing && alert.helmetId) {
      await this.prisma.helmetRiskAssessment.updateMany({
        where: { helmetId: alert.helmetId },
        data: { resolvedAt: now, resolutionReason: input.resolutionReason!.trim() },
      });
    }
    const action =
      input.status === 'RESOLVED'
        ? AuditAction.RISK_ALERT_RESOLVED
        : input.status === 'DISMISSED'
          ? AuditAction.RISK_ALERT_DISMISSED
          : input.status === 'ACKNOWLEDGED'
            ? AuditAction.RISK_ALERT_ACKNOWLEDGED
            : input.status === 'INVESTIGATING'
              ? AuditAction.RISK_ALERT_INVESTIGATING
              : AuditAction.RISK_ALERT_ASSIGNED;
    await this.audit.record({
      action,
      entityType: 'risk_alert',
      entityId: id,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: {
        type: alert.type,
        from: alert.status,
        to: input.status ?? alert.status,
        reasonGiven: !!input.resolutionReason,
      },
    });
    return this.get(id);
  }
}

export function toAlertDto(r: AlertRow): RiskAlertDto {
  return {
    id: r.id,
    type: r.type,
    label: RISK_ALERT_LABELS[r.type],
    status: r.status,
    priority: r.priority,
    helmet: r.helmet,
    sourceRef: r.sourceRef,
    summary: r.summary,
    reasons: (r.reasons as unknown as RiskReasonDto[]) ?? [],
    observedValue: r.observedValue,
    thresholdValue: r.thresholdValue,
    occurrences: r.occurrences,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    assignee: r.assignee,
    resolutionReason: r.resolutionReason,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedByName: r.resolvedBy?.name ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
