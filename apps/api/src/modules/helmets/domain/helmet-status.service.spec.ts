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

  it('owners can report lost/stolen/damaged and retire, but never recall or replace', () => {
    for (const to of ['LOST', 'STOLEN', 'DAMAGED', 'DEACTIVATED'] as const) {
      expect(() => service.assertTransition('ACTIVE', to, ActorType.OWNER)).not.toThrow();
      expect(() => service.assertTransition('ACTIVATED', to, ActorType.OWNER)).not.toThrow();
    }
    expect(() => service.assertTransition('ACTIVE', 'RECALLED', ActorType.OWNER)).toThrow();
    expect(() => service.assertTransition('ACTIVE', 'REPLACED', ActorType.OWNER)).toThrow();
  });

  it('lets owners restore lost/stolen helmets but only support can undo damage or retirement', () => {
    for (const from of ['LOST', 'STOLEN'] as const) {
      expect(() => service.assertTransition(from, 'ACTIVE', ActorType.OWNER)).not.toThrow();
      expect(() => service.assertTransition(from, 'ACTIVATED', ActorType.OWNER)).not.toThrow();
    }
    expect(() => service.assertTransition('DAMAGED', 'ACTIVATED', ActorType.OWNER)).toThrow();
    expect(() => service.assertTransition('DAMAGED', 'ACTIVATED', ActorType.ADMIN)).not.toThrow();
    expect(() => service.assertTransition('DEACTIVATED', 'ACTIVATED', ActorType.OWNER)).toThrow();
    expect(allowedTransitions('DEACTIVATED', ActorType.ADMIN)).toEqual(['ACTIVATED']);
  });

  it('treats REPLACED as terminal', () => {
    for (const actor of Object.values(ActorType))
      expect(allowedTransitions('REPLACED', actor)).toEqual([]);
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
        helmetTransfer: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
        data: { status: 'PRINTED', previousOperationalStatus: null },
      });
      expect(tx.helmetStatusHistory.create).toHaveBeenCalledWith({
        data: {
          helmetId: 'h1',
          fromStatus: 'GENERATED',
          toStatus: 'PRINTED',
          actorType: 'ADMIN',
          actorId: 'a1',
          reason: 'printed',
          reasonCode: null,
        },
      });
    });

    it('remembers the operational status when a helmet is interrupted', async () => {
      const tx = mockTx(1);
      await service.apply(tx as unknown as PrismaTx, {
        helmetId: 'h1',
        from: 'ACTIVE',
        to: 'LOST',
        actor: { type: ActorType.OWNER, id: 'u1' },
      });
      expect(tx.helmet.updateMany).toHaveBeenCalledWith({
        where: { id: 'h1', status: 'ACTIVE' },
        data: { status: 'LOST', previousOperationalStatus: 'ACTIVE' },
      });
      const lostToStolen = mockTx(1);
      await service.apply(lostToStolen as unknown as PrismaTx, {
        helmetId: 'h1',
        from: 'LOST',
        to: 'STOLEN',
        actor: { type: ActorType.OWNER, id: 'u1' },
      });
      // Moving between interruptions keeps the original operational status.
      expect(lostToStolen.helmet.updateMany).toHaveBeenCalledWith({
        where: { id: 'h1', status: 'LOST' },
        data: { status: 'STOLEN' },
      });
    });

    it('cancels a pending transfer when the helmet leaves a transferable status', async () => {
      const tx = mockTx(1);
      await service.apply(tx as unknown as PrismaTx, {
        helmetId: 'h1',
        from: 'ACTIVE',
        to: 'STOLEN',
        actor: { type: ActorType.OWNER, id: 'u1' },
      });
      expect(tx.helmetTransfer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { helmetId: 'h1', status: 'PENDING' } }),
      );
      const enable = mockTx(1);
      await service.apply(enable as unknown as PrismaTx, {
        helmetId: 'h1',
        from: 'ACTIVATED',
        to: 'ACTIVE',
        actor: { type: ActorType.OWNER, id: 'u1' },
      });
      expect(enable.helmetTransfer.updateMany).not.toHaveBeenCalled();
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
