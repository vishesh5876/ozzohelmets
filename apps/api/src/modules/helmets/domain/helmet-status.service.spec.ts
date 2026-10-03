import {
  ACTIVATABLE_STATUSES,
  ActorType,
  allowedTransitions,
  ErrorCode,
  HELMET_STATUS_TRANSITIONS,
  HELMET_STATUSES,
  HelmetStatus,
} from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import type { PrismaTx } from '../../../infrastructure/prisma/prisma.service';
import { HelmetStatusService } from './helmet-status.service';

describe('HelmetStatusService', () => {
  const service = new HelmetStatusService();

  it('allows the manufacturing happy path', () => {
    const path: HelmetStatus[] = ['GENERATED', 'PRINTED', 'IN_INVENTORY', 'SOLD'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(() => service.assertTransition(path[i]!, path[i + 1]!, ActorType.ADMIN)).not.toThrow();
    }
    expect(() => service.assertTransition('SOLD', 'ACTIVATED', ActorType.SYSTEM)).not.toThrow();
    expect(() => service.assertTransition('ACTIVATED', 'ACTIVE', ActorType.SYSTEM)).not.toThrow();
  });

  it.each<[HelmetStatus, HelmetStatus]>([
    ['GENERATED', 'SOLD'],
    ['GENERATED', 'ACTIVE'],
    ['PRINTED', 'ACTIVE'],
    ['ACTIVE', 'GENERATED'],
    ['ACTIVE', 'SOLD'],
    ['REPLACED', 'ACTIVE'],
    ['DEACTIVATED', 'ACTIVE'],
  ])('rejects %s → %s', (from, to) => {
    for (const actor of Object.values(ActorType)) {
      expect(() => service.assertTransition(from, to, actor)).toThrow(AppException);
    }
  });

  it('only the SYSTEM (activation flow) can activate', () => {
    for (const from of ACTIVATABLE_STATUSES) {
      expect(() => service.assertTransition(from, 'ACTIVATED', ActorType.ADMIN)).toThrow();
      expect(() => service.assertTransition(from, 'ACTIVATED', ActorType.OWNER)).toThrow();
      expect(() => service.assertTransition(from, 'ACTIVATED', ActorType.SYSTEM)).not.toThrow();
    }
  });

  it('owners can report lost/stolen but never deactivate or recall', () => {
    expect(() => service.assertTransition('ACTIVE', 'LOST', ActorType.OWNER)).not.toThrow();
    expect(() => service.assertTransition('ACTIVE', 'STOLEN', ActorType.OWNER)).not.toThrow();
    expect(() => service.assertTransition('ACTIVE', 'DEACTIVATED', ActorType.OWNER)).toThrow();
    expect(() => service.assertTransition('ACTIVE', 'RECALLED', ActorType.OWNER)).toThrow();
  });

  it('treats REPLACED and DEACTIVATED as terminal', () => {
    expect(allowedTransitions('REPLACED', ActorType.ADMIN)).toEqual([]);
    expect(allowedTransitions('DEACTIVATED', ActorType.ADMIN)).toEqual([]);
  });

  it('rejects no-op transitions', () => {
    expect(() => service.assertTransition('ACTIVE', 'ACTIVE', ActorType.ADMIN)).toThrow();
  });

  it('defines every status in the transition table and never self-loops', () => {
    expect(Object.keys(HELMET_STATUS_TRANSITIONS).sort()).toEqual([...HELMET_STATUSES].sort());
    for (const [from, edges] of Object.entries(HELMET_STATUS_TRANSITIONS)) {
      expect(Object.keys(edges)).not.toContain(from);
    }
  });

  it('every status is reachable from GENERATED', () => {
    const seen = new Set<HelmetStatus>(['GENERATED']);
    const queue: HelmetStatus[] = ['GENERATED'];
    while (queue.length) {
      const from = queue.shift()!;
      for (const to of Object.keys(HELMET_STATUS_TRANSITIONS[from]) as HelmetStatus[]) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    expect(seen.size).toBe(HELMET_STATUSES.length);
  });

  it('throws INVALID_STATUS_TRANSITION with the allowed targets', () => {
    try {
      service.assertTransition('GENERATED', 'SOLD', ActorType.ADMIN);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
      expect((err as AppException).details).toEqual({
        from: 'GENERATED',
        to: 'SOLD',
        allowed: ['PRINTED', 'DEACTIVATED'],
      });
    }
  });

  describe('apply', () => {
    function mockTx(updatedCount: number) {
      return {
        helmet: { updateMany: jest.fn().mockResolvedValue({ count: updatedCount }) },
        helmetStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      };
    }

    it('updates with an optimistic status guard and writes history', async () => {
      const tx = mockTx(1);
      await service.apply(tx as unknown as PrismaTx, {
        helmetId: 'h1',
        from: 'GENERATED',
        to: 'PRINTED',
        actor: { type: ActorType.ADMIN, id: 'a1' },
        reason: 'printed',
      });
      expect(tx.helmet.updateMany).toHaveBeenCalledWith({
        where: { id: 'h1', status: 'GENERATED' },
        data: { status: 'PRINTED' },
      });
      expect(tx.helmetStatusHistory.create).toHaveBeenCalledWith({
        data: {
          helmetId: 'h1',
          fromStatus: 'GENERATED',
          toStatus: 'PRINTED',
          actorType: 'ADMIN',
          actorId: 'a1',
          reason: 'printed',
        },
      });
    });

    it('fails when the status changed concurrently', async () => {
      const tx = mockTx(0);
      await expect(
        service.apply(tx as unknown as PrismaTx, {
          helmetId: 'h1',
          from: 'GENERATED',
          to: 'PRINTED',
          actor: { type: ActorType.ADMIN, id: null },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(tx.helmetStatusHistory.create).not.toHaveBeenCalled();
    });

    it('does not touch the database for invalid transitions', async () => {
      const tx = mockTx(1);
      await expect(
        service.apply(tx as unknown as PrismaTx, {
          helmetId: 'h1',
          from: 'GENERATED',
          to: 'ACTIVE',
          actor: { type: ActorType.ADMIN, id: null },
        }),
      ).rejects.toThrow(AppException);
      expect(tx.helmet.updateMany).not.toHaveBeenCalled();
    });
  });
});
