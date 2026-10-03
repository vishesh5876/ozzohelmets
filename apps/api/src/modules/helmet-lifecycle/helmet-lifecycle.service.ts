import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ActorType,
  type CustomerHelmetDto,
  type DamageReason,
  ErrorCode,
  type HelmetStatus,
  normalizeHelmetCode,
  type OwnerHelmetAction,
} from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { RecentAuthService } from '../../security/recent-auth.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CustomerHelmetsService } from '../customer-helmets/customer-helmets.service';
import { EmergencyReadinessService } from '../emergency-readiness/emergency-readiness.service';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { type LockedHelmet, OwnedHelmetLocker } from '../helmets/domain/owned-helmet.locker';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { assertOwnerAction, restoreTarget, SUPPORT_RESTORABLE } from './domain/lifecycle-policy';

interface OwnerStep {
  action: OwnerHelmetAction;
  /** Target status; `'restore'` resolves to the remembered operational state. */
  to: HelmetStatus | 'restore';
  reasonCode: string;
  reason: string;
  audit: AuditAction;
  /** Sensitive actions need a fresh password confirmation (X-Recent-Auth). */
  recentAuth: boolean;
  /** Turns the per-helmet emergency switch off (retirement). */
  switchOff?: boolean;
}

const STEPS = {
  lost: {
    action: 'REPORT_LOST',
    to: 'LOST',
    reasonCode: 'LOST_REPORTED',
    reason: 'Reported lost by owner',
    audit: AuditAction.HELMET_MARKED_LOST,
    recentAuth: false,
  },
  found: {
    action: 'MARK_FOUND',
    to: 'restore',
    reasonCode: 'FOUND',
    reason: 'Found by owner',
    audit: AuditAction.HELMET_FOUND,
    recentAuth: false,
  },
  stolen: {
    action: 'REPORT_STOLEN',
    to: 'STOLEN',
    reasonCode: 'STOLEN_REPORTED',
    reason: 'Reported stolen by owner',
    audit: AuditAction.HELMET_MARKED_STOLEN,
    recentAuth: true,
  },
  recovered: {
    action: 'MARK_RECOVERED',
    to: 'restore',
    reasonCode: 'RECOVERED',
    reason: 'Recovered by owner',
    audit: AuditAction.HELMET_RECOVERED,
    recentAuth: true,
  },
} satisfies Record<string, OwnerStep>;

/**
 * Owner-driven lifecycle (lost, found, stolen, recovered, damaged, retired) and support actions
 * (restore, forced deactivation). Every change: row lock → policy → HelmetStatusService (table,
 * optimistic guard, history, previous-status bookkeeping, pending-transfer cancellation) → audit
 * → commit → public cache invalidation. Ownership is never changed here.
 */
@Injectable()
export class HelmetLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locker: OwnedHelmetLocker,
    private readonly statuses: HelmetStatusService,
    private readonly readiness: EmergencyReadinessService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly recentAuth: RecentAuthService,
    private readonly customerHelmets: CustomerHelmetsService,
  ) {}

  reportLost(c: AuthenticatedCustomer, helmetId: string, meta: RequestMeta) {
    return this.ownerAction(c, helmetId, STEPS.lost, undefined, meta);
  }

  markFound(c: AuthenticatedCustomer, helmetId: string, meta: RequestMeta) {
    return this.ownerAction(c, helmetId, STEPS.found, undefined, meta);
  }

  reportStolen(
    c: AuthenticatedCustomer,
    helmetId: string,
    token: string | undefined,
    meta: RequestMeta,
  ) {
    return this.ownerAction(c, helmetId, STEPS.stolen, token, meta);
  }

  markRecovered(
    c: AuthenticatedCustomer,
    helmetId: string,
    token: string | undefined,
    meta: RequestMeta,
  ) {
    return this.ownerAction(c, helmetId, STEPS.recovered, token, meta);
  }

  markDamaged(
    c: AuthenticatedCustomer,
    helmetId: string,
    input: { reason?: DamageReason; note?: string },
    meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.ownerAction(
      c,
      helmetId,
      {
        action: 'MARK_DAMAGED',
        to: 'DAMAGED',
        reasonCode: `DAMAGED:${input.reason ?? 'UNSPECIFIED'}`,
        // Optional short owner note (length-limited); never medical data.
        reason: input.note?.trim()
          ? `Marked damaged by owner: ${input.note.trim()}`
          : 'Marked damaged by owner',
        audit: AuditAction.HELMET_MARKED_DAMAGED,
        recentAuth: false,
      },
      undefined,
      meta,
      { damageReason: input.reason ?? null },
    );
  }

  /** Permanent retirement by the owner; typing the Helmet ID confirms intent. Support can undo. */
  async retire(
    c: AuthenticatedCustomer,
    helmetId: string,
    confirmHelmetCode: string,
    token: string | undefined,
    meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.ownerAction(
      c,
      helmetId,
      {
        action: 'RETIRE',
        to: 'DEACTIVATED',
        reasonCode: 'RETIRED_BY_OWNER',
        reason: 'Retired by owner',
        audit: AuditAction.HELMET_DEACTIVATED,
        recentAuth: true,
        switchOff: true,
      },
      token,
      meta,
      undefined,
      (helmet) => {
        if (normalizeHelmetCode(confirmHelmetCode) !== helmet.helmetCode) {
          throw new AppException(
            ErrorCode.CONFIRMATION_MISMATCH,
            'Type the Helmet ID exactly as shown to confirm.',
            HttpStatus.BAD_REQUEST,
          );
        }
      },
    );
  }

  // ───────────── Support ─────────────

  /** Support restores a LOST/STOLEN/DAMAGED/DEACTIVATED owned helmet to its safe operational state. */
  async supportRestore(
    admin: AuthenticatedAdmin,
    helmetId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    const token = await this.prisma.$transaction(async (tx) => {
      const { helmet, ownerId } = await this.lockForSupport(tx, helmetId);
      if (!ownerId) {
        throw AppException.notFound(
          ErrorCode.OWNERSHIP_NOT_FOUND,
          'This helmet has no current owner.',
        );
      }
      if (!SUPPORT_RESTORABLE.includes(helmet.status)) {
        throw AppException.conflict(
          ErrorCode.HELMET_NOT_RECOVERABLE,
          'Only lost, stolen, damaged or deactivated helmets can be restored.',
          { status: helmet.status },
        );
      }
      const to = restoreTarget(
        helmet.previousOperationalStatus,
        await this.readiness.canExpose(ownerId, helmet.id, tx),
      );
      await this.statuses.apply(tx, {
        helmetId,
        from: helmet.status,
        to,
        actor: { type: ActorType.ADMIN, id: admin.id },
        reason,
        reasonCode: 'RESTORED_BY_SUPPORT',
      });
      await this.audit.record(
        {
          action: AuditAction.HELMET_STATUS_RESTORED,
          entityType: 'helmet',
          entityId: helmetId,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { from: helmet.status, to, reason },
        },
        tx,
      );
      return helmet.publicToken;
    });
    await this.cache.invalidate(token);
  }

  /** Support forces DEACTIVATED (requires a recent admin password confirmation). */
  async supportDeactivate(
    admin: AuthenticatedAdmin,
    helmetId: string,
    reason: string,
    token: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.recentAuth.assert('admin', admin.id, null, token);
    const publicToken = await this.prisma.$transaction(async (tx) => {
      const { helmet, ownerId } = await this.lockForSupport(tx, helmetId);
      await this.statuses.apply(tx, {
        helmetId,
        from: helmet.status,
        to: 'DEACTIVATED',
        actor: { type: ActorType.ADMIN, id: admin.id },
        reason,
        reasonCode: 'DEACTIVATED_BY_SUPPORT',
      });
      if (ownerId) {
        await tx.helmetEmergencySetting.updateMany({
          where: { helmetId, userId: ownerId },
          data: { enabled: false },
        });
      }
      await this.audit.record(
        {
          action: AuditAction.HELMET_DEACTIVATED,
          entityType: 'helmet',
          entityId: helmetId,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { from: helmet.status, by: 'support', reason },
        },
        tx,
      );
      return helmet.publicToken;
    });
    await this.cache.invalidate(publicToken);
  }

  /** What a support restore would set right now (for the admin UI), or null. */
  async restorePreview(
    helmetId: string,
    status: HelmetStatus,
    previous: HelmetStatus | null,
    ownerId: string | null,
  ): Promise<HelmetStatus | null> {
    if (!ownerId || !SUPPORT_RESTORABLE.includes(status)) return null;
    return restoreTarget(previous, await this.readiness.canExpose(ownerId, helmetId));
  }

  // ───────────── Internals ─────────────

  private async ownerAction(
    customer: AuthenticatedCustomer,
    helmetId: string,
    step: OwnerStep,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
    auditExtra?: Record<string, unknown>,
    confirm?: (helmet: LockedHelmet) => void,
  ): Promise<CustomerHelmetDto> {
    if (step.recentAuth) {
      await this.recentAuth.assert('customer', customer.id, customer.sessionId, recentAuthToken);
    }
    const token = await this.prisma.$transaction(async (tx) => {
      const { helmet } = await this.locker.lockOwned(tx, helmetId, customer.id);
      assertOwnerAction(helmet.status, step.action);
      confirm?.(helmet);
      const to =
        step.to === 'restore'
          ? restoreTarget(
              helmet.previousOperationalStatus,
              await this.readiness.canExpose(customer.id, helmet.id, tx),
            )
          : step.to;
      await this.statuses.apply(tx, {
        helmetId,
        from: helmet.status,
        to,
        actor: { type: ActorType.OWNER, id: customer.id },
        reason: step.reason.slice(0, 500),
        reasonCode: step.reasonCode,
      });
      if (step.switchOff) {
        await tx.helmetEmergencySetting.updateMany({
          where: { helmetId, userId: customer.id },
          data: { enabled: false },
        });
      }
      await this.audit.record(
        {
          action: step.audit,
          entityType: 'helmet',
          entityId: helmetId,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { from: helmet.status, to, ...(auditExtra ?? {}) },
        },
        tx,
      );
      return helmet.publicToken;
    });
    // Safety-critical: the public page must reflect the new state on the very next scan.
    await this.cache.invalidate(token);
    return this.customerHelmets.get(customer.id, helmetId);
  }

  private async lockForSupport(
    tx: PrismaTx,
    helmetId: string,
  ): Promise<{ helmet: LockedHelmet; ownerId: string | null }> {
    const locked = await this.locker.lock(tx, { id: helmetId });
    if (!locked) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    return { helmet: locked.helmet, ownerId: locked.ownership?.userId ?? null };
  }
}
