import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ActorType,
  canTransitionSafetyId,
  ErrorCode,
  type HelmetStatus,
  OPERATIONAL_STATUSES,
  SAFETY_ID_IN_USE,
  type SafetyIdOwnershipSource,
  type SafetyIdStatus,
} from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import type { PrismaTx } from '../../../infrastructure/prisma/prisma.service';
import { HelmetStatusService, type StatusActor } from '../../helmets/domain/helmet-status.service';

export interface LockedSafetyId {
  id: string;
  safetyCode: string;
  publicToken: string;
  status: SafetyIdStatus;
  activationPinHash: string;
  activationPinUsed: boolean;
  activationAttempts: number;
  activationLockedUntil: Date | null;
}

export interface LockedLinkedHelmet {
  id: string;
  helmetCode: string;
  status: HelmetStatus;
  ownerId: string | null;
}

export interface LockedSafetyIdState {
  safetyId: LockedSafetyId;
  ownership: { id: string; userId: string } | null;
  helmet: LockedLinkedHelmet | null;
}

interface SafetyRow {
  id: string;
  safety_code: string;
  public_token: string;
  status: SafetyIdStatus;
  activation_pin_hash: string;
  activation_pin_used: boolean;
  activation_attempts: number;
  activation_locked_until: Date | null;
}

type SafetyWhere = { id: string } | { publicToken: string } | { safetyCode: string };

/**
 * Transaction-level rules shared by every module that touches a Safety ID: row locks, status
 * transitions, the emergency sharing switch (with the dual-write onto a linked helmet) and
 * ownership periods.
 *
 * Lock order is always: linked helmet row → its ACTIVE helmet ownership → Safety ID row → its
 * ACTIVE Safety ID ownership. Helmet lifecycle code (which locks the helmet first) and Safety ID
 * code therefore serialise instead of deadlocking.
 *
 * Invariant: a linked Safety ID and its helmet never have different current owners.
 */
@Injectable()
export class SafetyIdCoreService {
  constructor(private readonly helmetStatuses: HelmetStatusService) {}

  /** Resolves a Safety ID id without locking (null when unknown). */
  async findId(tx: PrismaTx, where: SafetyWhere): Promise<string | null> {
    const row = await tx.safetyId.findUnique({ where, select: { id: true } });
    return row?.id ?? null;
  }

  /** Current link of a Safety ID (unlocked read). */
  async linkedHelmetId(tx: PrismaTx, safetyId: string): Promise<string | null> {
    const link = await tx.safetyIdHelmetLink.findFirst({
      where: { safetyId, endedAt: null },
      select: { helmetId: true },
    });
    return link?.helmetId ?? null;
  }

  /** Safety ID currently linked to a helmet (unlocked read). */
  async linkedSafetyId(
    tx: PrismaTx,
    helmetId: string,
  ): Promise<{ id: string; publicToken: string } | null> {
    const link = await tx.safetyIdHelmetLink.findFirst({
      where: { helmetId, endedAt: null },
      select: { safetyIdRef: { select: { id: true, publicToken: true } } },
    });
    return link?.safetyIdRef ?? null;
  }

  /**
   * Locks a Safety ID together with its linked helmet (helmet first), their ACTIVE ownerships,
   * and re-checks that the link did not change while waiting for the locks.
   */
  async lock(tx: PrismaTx, where: SafetyWhere): Promise<LockedSafetyIdState | null> {
    const id = 'id' in where ? where.id : await this.findId(tx, where);
    if (!id) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const helmetId = await this.linkedHelmetId(tx, id);
      const helmet = helmetId ? await this.lockHelmet(tx, helmetId) : null;
      const rows = await tx.$queryRaw<SafetyRow[]>`
        SELECT id, safety_code, public_token, status, activation_pin_hash, activation_pin_used,
               activation_attempts, activation_locked_until
        FROM safety_ids WHERE id = ${id}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) return null;
      // The link only changes under the Safety ID row lock, so this re-read is stable.
      if ((await this.linkedHelmetId(tx, id)) !== helmetId) continue;
      const owners = await tx.$queryRaw<{ id: string; user_id: string }[]>`
        SELECT id, user_id FROM safety_id_ownerships
        WHERE safety_id = ${id}::uuid AND status = 'ACTIVE'::"OwnershipStatus" FOR UPDATE`;
      return {
        safetyId: {
          id: row.id,
          safetyCode: row.safety_code,
          publicToken: row.public_token,
          status: row.status,
          activationPinHash: row.activation_pin_hash,
          activationPinUsed: row.activation_pin_used,
          activationAttempts: row.activation_attempts,
          activationLockedUntil: row.activation_locked_until,
        },
        ownership: owners[0] ? { id: owners[0].id, userId: owners[0].user_id } : null,
        helmet,
      };
    }
    throw new AppException(
      ErrorCode.CONFLICT,
      'This Safety ID changed while it was being updated. Try again.',
      HttpStatus.CONFLICT,
    );
  }

  /** Locks a Safety ID the customer currently owns; otherwise 404 (ownership can't be probed). */
  async lockOwned(tx: PrismaTx, safetyId: string, userId: string): Promise<LockedSafetyIdState> {
    const state = await this.lock(tx, { id: safetyId });
    if (!state?.ownership || state.ownership.userId !== userId)
      throw AppException.notFound(ErrorCode.SAFETY_ID_NOT_FOUND, 'Safety ID not found.');
    return state;
  }

  /** Guarded status change (`WHERE status = from`), validated against the transition table. */
  async setStatus(
    tx: PrismaTx,
    id: string,
    from: SafetyIdStatus,
    to: SafetyIdStatus,
    extra: {
      activatedAt?: Date;
      deactivatedAt?: Date | null;
      activationPinUsed?: boolean;
      activationAttempts?: number;
      activationLockedUntil?: Date | null;
    } = {},
  ): Promise<void> {
    if (from === to) return;
    if (!canTransitionSafetyId(from, to))
      throw new AppException(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `Cannot change Safety ID status from ${from} to ${to}.`,
        HttpStatus.CONFLICT,
        { from, to },
      );
    const updated = await tx.safetyId.updateMany({
      where: { id, status: from },
      data: { status: to, ...extra },
    });
    if (updated.count !== 1)
      throw new AppException(
        ErrorCode.CONFLICT,
        'Safety ID status changed concurrently. Reload and try again.',
        HttpStatus.CONFLICT,
      );
  }

  /**
   * Turns emergency sharing ON for one Safety ID owned by `userId` (caller holds the user lock
   * and has checked the profile may be enabled). ACTIVATED → ACTIVE. A linked helmet must be in
   * normal use; its own switch and ACTIVATED → ACTIVE status are written too (Phase 8 rollback
   * compatibility, helmet lifecycle restore). Returns the public token to invalidate.
   */
  async switchOn(tx: PrismaTx, safetyId: string, userId: string): Promise<string> {
    const state = await this.lockOwned(tx, safetyId, userId);
    const { safetyId: sid, helmet } = state;
    if (!SAFETY_ID_IN_USE.includes(sid.status))
      throw new AppException(
        ErrorCode.SAFETY_ID_ACTION_NOT_ALLOWED,
        'Emergency sharing can only be turned on for an active Safety ID.',
        HttpStatus.CONFLICT,
        { status: sid.status },
      );
    if (helmet && !OPERATIONAL_STATUSES.includes(helmet.status))
      throw new AppException(
        ErrorCode.SAFETY_ID_ACTION_NOT_ALLOWED,
        'The helmet linked to this Safety ID is not in normal use, so emergency sharing cannot be turned on.',
        HttpStatus.CONFLICT,
        { helmetStatus: helmet.status },
      );
    const now = new Date();
    await tx.safetyIdEmergencySetting.upsert({
      where: { safetyId_userId: { safetyId: sid.id, userId } },
      create: { safetyId: sid.id, userId, enabled: true, confirmedAt: now },
      update: { enabled: true, confirmedAt: now },
    });
    await this.setStatus(tx, sid.id, sid.status, 'ACTIVE');
    if (helmet && helmet.ownerId === userId) {
      await tx.helmetEmergencySetting.upsert({
        where: { helmetId_userId: { helmetId: helmet.id, userId } },
        create: { helmetId: helmet.id, userId, enabled: true, confirmedAt: now },
        update: { enabled: true, confirmedAt: now },
      });
      if (helmet.status === 'ACTIVATED')
        await this.helmetStatuses.apply(tx, {
          helmetId: helmet.id,
          from: 'ACTIVATED',
          to: 'ACTIVE',
          actor: { type: ActorType.OWNER, id: userId },
          reason: 'Emergency sharing turned on for the linked Safety ID',
          reasonCode: 'EMERGENCY_ENABLED',
        });
    }
    return sid.publicToken;
  }

  /**
   * Turns emergency sharing OFF for one Safety ID (owner or system action). ACTIVE → ACTIVATED,
   * mirrored onto a linked helmet. Returns the public token to invalidate.
   */
  async switchOff(
    tx: PrismaTx,
    safetyId: string,
    userId: string,
    actor: StatusActor = { type: ActorType.OWNER, id: userId },
  ): Promise<string> {
    const state = await this.lockOwned(tx, safetyId, userId);
    await this.switchOffLocked(tx, state, userId, actor);
    return state.safetyId.publicToken;
  }

  private async switchOffLocked(
    tx: PrismaTx,
    state: LockedSafetyIdState,
    userId: string,
    actor: StatusActor,
  ): Promise<void> {
    const { safetyId: sid, helmet } = state;
    await tx.safetyIdEmergencySetting.upsert({
      where: { safetyId_userId: { safetyId: sid.id, userId } },
      create: { safetyId: sid.id, userId, enabled: false },
      update: { enabled: false },
    });
    if (sid.status === 'ACTIVE') await this.setStatus(tx, sid.id, 'ACTIVE', 'ACTIVATED');
    if (helmet && helmet.ownerId === userId) {
      await tx.helmetEmergencySetting.updateMany({
        where: { helmetId: helmet.id, userId, enabled: true },
        data: { enabled: false },
      });
      if (helmet.status === 'ACTIVE')
        await this.helmetStatuses.apply(tx, {
          helmetId: helmet.id,
          from: 'ACTIVE',
          to: 'ACTIVATED',
          actor,
          reason: 'Emergency sharing turned off for the linked Safety ID',
          reasonCode: 'EMERGENCY_DISABLED',
        });
    }
  }

  /**
   * Helmet-side mirror: the caller (helmet lifecycle, replacement, revoke, transfer, account
   * deletion) already switched the helmet off and moved its status. This turns the linked Safety
   * ID's switch off too (ACTIVE → ACTIVATED) without touching the helmet again. Returns the token
   * to invalidate (null when the helmet has no Safety ID).
   */
  async mirrorHelmetSharingOff(
    tx: PrismaTx,
    helmetId: string,
    userId: string | null,
  ): Promise<string | null> {
    const linked = await this.linkedSafetyId(tx, helmetId);
    if (!linked) return null;
    const [row] = await tx.$queryRaw<{ status: SafetyIdStatus }[]>`
      SELECT status FROM safety_ids WHERE id = ${linked.id}::uuid FOR UPDATE`;
    if (userId)
      await tx.safetyIdEmergencySetting.updateMany({
        where: { safetyId: linked.id, userId, enabled: true },
        data: { enabled: false },
      });
    else
      await tx.safetyIdEmergencySetting.updateMany({
        where: { safetyId: linked.id, enabled: true },
        data: { enabled: false },
      });
    if (row?.status === 'ACTIVE') await this.setStatus(tx, linked.id, 'ACTIVE', 'ACTIVATED');
    return linked.publicToken;
  }

  /**
   * Turns every Safety ID switch of a customer off (profile disabled, account deleted). Linked
   * helmets are handled by the caller's helmet loop; this only mirrors the Safety ID side.
   */
  async switchOffAllForUser(tx: PrismaTx, userId: string): Promise<string[]> {
    await tx.safetyIdEmergencySetting.updateMany({
      where: { userId, enabled: true },
      data: { enabled: false },
    });
    const rows = await tx.$queryRaw<{ id: string; public_token: string }[]>`
      SELECT s.id, s.public_token FROM safety_ids s
      JOIN safety_id_ownerships o ON o.safety_id = s.id AND o.status = 'ACTIVE'::"OwnershipStatus"
      WHERE o.user_id = ${userId}::uuid AND s.status = 'ACTIVE'::"SafetyIdStatus"
      FOR UPDATE OF s`;
    for (const r of rows) await this.setStatus(tx, r.id, 'ACTIVE', 'ACTIVATED');
    const owned = await tx.safetyIdOwnership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { safetyIdRef: { select: { publicToken: true } } },
    });
    return owned.map((o) => o.safetyIdRef.publicToken);
  }

  /** Starts an ownership period (the partial unique index allows one ACTIVE owner). */
  async startOwnership(
    tx: PrismaTx,
    safetyId: string,
    userId: string,
    source: SafetyIdOwnershipSource,
    at: Date,
    transferId?: string,
  ): Promise<void> {
    await tx.safetyIdOwnership.create({
      data: { safetyId, userId, status: 'ACTIVE', source, startedAt: at, transferId },
    });
  }

  /**
   * Ends the current ownership period (transfer or revoke) and switches the previous owner's
   * sharing off (ACTIVE → ACTIVATED). The new owner always starts with sharing off.
   */
  async endOwnership(
    tx: PrismaTx,
    safetyId: string,
    status: 'TRANSFERRED' | 'REVOKED',
    endReason: string,
    at: Date,
  ): Promise<string | null> {
    const current = await tx.safetyIdOwnership.findFirst({
      where: { safetyId, status: 'ACTIVE' },
      select: { id: true, userId: true },
    });
    if (!current) return null;
    await tx.safetyIdOwnership.update({
      where: { id: current.id },
      data: { status, endedAt: at, endReason },
    });
    await tx.safetyIdEmergencySetting.updateMany({
      where: { safetyId, userId: current.userId, enabled: true },
      data: { enabled: false },
    });
    const row = await tx.safetyId.findUniqueOrThrow({
      where: { id: safetyId },
      select: { status: true },
    });
    if (row.status === 'ACTIVE') await this.setStatus(tx, safetyId, 'ACTIVE', 'ACTIVATED');
    return current.userId;
  }

  /**
   * Helmet ownership moved (helmet transfer claim) or ended (revoke): the linked Safety ID
   * follows so both keep the same owner. Caller holds the helmet lock. Returns the token.
   */
  async followHelmetOwnership(
    tx: PrismaTx,
    helmetId: string,
    change:
      | { kind: 'transfer'; toUserId: string; at: Date }
      | { kind: 'revoke'; reason: string; at: Date },
  ): Promise<string | null> {
    const linked = await this.linkedSafetyId(tx, helmetId);
    if (!linked) return null;
    await tx.$queryRaw`SELECT id FROM safety_ids WHERE id = ${linked.id}::uuid FOR UPDATE`;
    if (change.kind === 'transfer') {
      await this.endOwnership(tx, linked.id, 'TRANSFERRED', 'HELMET_TRANSFER', change.at);
      await this.startOwnership(tx, linked.id, change.toUserId, 'TRANSFER', change.at);
      // A pending standalone transfer can't survive a change of owner.
      await tx.safetyIdTransfer.updateMany({
        where: { safetyId: linked.id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: change.at, cancelReason: 'HELMET_TRANSFER' },
      });
    } else {
      await this.endOwnership(tx, linked.id, 'REVOKED', change.reason, change.at);
    }
    return linked.publicToken;
  }

  /**
   * Creates the current link. Both sides must be free (partial unique indexes back this up),
   * and they must have the same current owner, or the Safety ID none / the helmet none.
   */
  async link(
    tx: PrismaTx,
    safetyId: string,
    helmetId: string,
    reason: string,
    adminId: string | null,
    at: Date = new Date(),
  ): Promise<void> {
    await tx.safetyIdHelmetLink.create({
      data: { safetyId, helmetId, reason, createdByAdminId: adminId, startedAt: at },
    });
  }

  async unlink(tx: PrismaTx, safetyId: string, at: Date = new Date()): Promise<string | null> {
    const link = await tx.safetyIdHelmetLink.findFirst({
      where: { safetyId, endedAt: null },
      select: { id: true, helmetId: true },
    });
    if (!link) return null;
    await tx.safetyIdHelmetLink.update({ where: { id: link.id }, data: { endedAt: at } });
    return link.helmetId;
  }

  private async lockHelmet(tx: PrismaTx, helmetId: string): Promise<LockedLinkedHelmet | null> {
    const rows = await tx.$queryRaw<{ id: string; helmet_code: string; status: HelmetStatus }[]>`
      SELECT id, helmet_code, status FROM helmets WHERE id = ${helmetId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;
    const owners = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM helmet_ownerships
      WHERE helmet_id = ${helmetId}::uuid AND status = 'ACTIVE'::"OwnershipStatus" FOR UPDATE`;
    return {
      id: row.id,
      helmetCode: row.helmet_code,
      status: row.status,
      ownerId: owners[0]?.user_id ?? null,
    };
  }
}
