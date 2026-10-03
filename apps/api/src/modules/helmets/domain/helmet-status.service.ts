import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActorType,
  allowedTransitions,
  canTransition,
  ErrorCode,
  type HelmetStatus,
} from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import type { PrismaTx } from '../../../infrastructure/prisma/prisma.service';

export interface StatusActor {
  type: ActorType;
  id: string | null;
}

export interface TransitionInput {
  helmetId: string;
  from: HelmetStatus;
  to: HelmetStatus;
  actor: StatusActor;
  reason?: string | null;
  /** Extra columns to set atomically with the status (e.g. activatedAt). */
  extra?: { activatedAt?: Date };
}

/**
 * Domain service owning helmet lifecycle rules. All status changes MUST go through
 * `apply()` so the transition table, optimistic concurrency check and history stay consistent.
 */
@Injectable()
export class HelmetStatusService {
  assertTransition(from: HelmetStatus, to: HelmetStatus, actor: ActorType): void {
    if (from === to || !canTransition(from, to, actor)) {
      throw new AppException(
        ErrorCode.INVALID_STATUS_TRANSITION,
        `Cannot change helmet status from ${from} to ${to}.`,
        HttpStatus.CONFLICT,
        { from, to, allowed: allowedTransitions(from, actor) },
      );
    }
  }

  allowed(from: HelmetStatus, actor: ActorType): HelmetStatus[] {
    return allowedTransitions(from, actor);
  }

  /**
   * Applies a validated transition inside the caller's transaction. The `WHERE status = from`
   * guard makes concurrent conflicting transitions fail instead of silently overwriting.
   */
  async apply(tx: PrismaTx, input: TransitionInput): Promise<void> {
    this.assertTransition(input.from, input.to, input.actor.type);
    const updated = await tx.helmet.updateMany({
      where: { id: input.helmetId, status: input.from },
      data: { status: input.to, ...(input.extra ?? {}) },
    });
    if (updated.count !== 1) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Helmet status changed concurrently. Reload and try again.',
        HttpStatus.CONFLICT,
      );
    }
    await tx.helmetStatusHistory.create({
      data: {
        helmetId: input.helmetId,
        fromStatus: input.from,
        toStatus: input.to,
        actorType: input.actor.type,
        actorId: input.actor.id,
        reason: input.reason ?? null,
      },
    });
  }
}
