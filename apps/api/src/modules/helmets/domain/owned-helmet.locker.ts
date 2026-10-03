import { Injectable } from '@nestjs/common';
import { ErrorCode, type HelmetStatus } from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import type { PrismaTx } from '../../../infrastructure/prisma/prisma.service';

export interface LockedHelmet {
  id: string;
  helmetCode: string;
  status: HelmetStatus;
  publicToken: string;
  previousOperationalStatus: HelmetStatus | null;
}

export interface LockedOwnership {
  id: string;
  userId: string;
}

interface HelmetRow {
  id: string;
  helmet_code: string;
  status: HelmetStatus;
  public_token: string;
  previous_operational_status: HelmetStatus | null;
}

/**
 * Row locks for lifecycle operations. Lock order is always helmet row → its ACTIVE ownership row
 * (→ transfer row), so concurrent transfer claims, lifecycle actions and support actions on the
 * same helmet serialise instead of deadlocking or racing.
 */
@Injectable()
export class OwnedHelmetLocker {
  /** Locks a helmet and its ACTIVE ownership; null owner when the helmet has none. */
  async lock(
    tx: PrismaTx,
    where: { id: string } | { helmetCode: string },
  ): Promise<{ helmet: LockedHelmet; ownership: LockedOwnership | null } | null> {
    const rows =
      'id' in where
        ? await tx.$queryRaw<HelmetRow[]>`
            SELECT id, helmet_code, status, public_token, previous_operational_status
            FROM helmets WHERE id = ${where.id}::uuid FOR UPDATE`
        : await tx.$queryRaw<HelmetRow[]>`
            SELECT id, helmet_code, status, public_token, previous_operational_status
            FROM helmets WHERE helmet_code = ${where.helmetCode} FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;
    const owners = await tx.$queryRaw<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM helmet_ownerships
      WHERE helmet_id = ${row.id}::uuid AND status = 'ACTIVE'::"OwnershipStatus" FOR UPDATE`;
    return {
      helmet: {
        id: row.id,
        helmetCode: row.helmet_code,
        status: row.status,
        publicToken: row.public_token,
        previousOperationalStatus: row.previous_operational_status,
      },
      ownership: owners[0] ? { id: owners[0].id, userId: owners[0].user_id } : null,
    };
  }

  /**
   * Locks a helmet the customer currently owns. A helmet owned by someone else is
   * indistinguishable from a missing one (404), so ownership can't be probed.
   */
  async lockOwned(
    tx: PrismaTx,
    helmetId: string,
    userId: string,
  ): Promise<{ helmet: LockedHelmet; ownership: LockedOwnership }> {
    const locked = await this.lock(tx, { id: helmetId });
    if (!locked?.ownership || locked.ownership.userId !== userId) {
      throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    }
    return { helmet: locked.helmet, ownership: locked.ownership };
  }
}
