import type { AppConfigService } from '../../config/app-config.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { canMoveAlert, RiskAlertsService, sourceRefFor } from './risk-alerts.service';

type Row = {
  id: string;
  dedupKey: string;
  status: string;
  priority: string;
  observedValue: number | null;
  thresholdValue: number | null;
  occurrences: number;
  resolvedAt: Date | null;
};

/** Minimal in-memory riskAlert table honouring the "one open alert per dedup key" rule. */
function fakePrisma() {
  const rows: Row[] = [];
  const open = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'];
  return {
    rows,
    riskAlert: {
      findFirst: async ({
        where,
      }: {
        where: { dedupKey: string; status: { in: string[] }; resolvedAt?: { gt: Date } };
      }) =>
        rows
          .filter(
            (r) =>
              r.dedupKey === where.dedupKey &&
              where.status.in.includes(r.status) &&
              (!where.resolvedAt || (r.resolvedAt && r.resolvedAt > where.resolvedAt.gt)),
          )
          .sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0))[0] ??
        null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        r.occurrences += 1;
        r.priority = data.priority as string;
        r.observedValue = data.observedValue as number;
        return r;
      },
      create: async ({ data }: { data: Row }) => {
        if (rows.some((r) => r.dedupKey === data.dedupKey && open.includes(r.status)))
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        const r = {
          ...data,
          id: `a${rows.length + 1}`,
          status: 'OPEN',
          occurrences: 1,
          resolvedAt: null,
        };
        rows.push(r);
        return r;
      },
    },
  };
}

const config = { get: () => 24 } as unknown as AppConfigService;
const input = (observedValue: number) => ({
  type: 'HIGH_PUBLIC_SCAN_VOLUME' as const,
  dedupKey: 'helmet:h1:volume',
  priority: 'LOW' as const,
  summary: 'High public scan volume. Review recommended.',
  helmetId: 'h1',
  observedValue,
  thresholdValue: 50,
});

describe('risk alert lifecycle', () => {
  it('allows only forward human transitions; resolved/dismissed are final', () => {
    expect(canMoveAlert('OPEN', 'ACKNOWLEDGED')).toBe(true);
    expect(canMoveAlert('OPEN', 'DISMISSED')).toBe(true);
    expect(canMoveAlert('INVESTIGATING', 'ACKNOWLEDGED')).toBe(true);
    expect(canMoveAlert('ACKNOWLEDGED', 'OPEN')).toBe(false);
    expect(canMoveAlert('RESOLVED', 'OPEN')).toBe(false);
    expect(canMoveAlert('DISMISSED', 'INVESTIGATING')).toBe(false);
  });

  it('source references are opaque and stable', () => {
    expect(sourceRefFor('abc')).toBe(sourceRefFor('abc'));
    expect(sourceRefFor('abc')).not.toBe(sourceRefFor('abd'));
    expect(sourceRefFor('abc')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('deduplicates repeated observations into one open alert, keeping the highest priority', async () => {
    const prisma = fakePrisma();
    const svc = new RiskAlertsService(
      prisma as unknown as PrismaService,
      config,
      {} as AuditService,
    );
    await svc.raise(input(60));
    await svc.raise({ ...input(80), priority: 'MEDIUM' });
    await svc.raise(input(70));
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ occurrences: 3, priority: 'MEDIUM', observedValue: 80 });
  });

  it('after a resolution the same pattern stays quiet unless it at least doubles', async () => {
    const prisma = fakePrisma();
    const svc = new RiskAlertsService(
      prisma as unknown as PrismaService,
      config,
      {} as AuditService,
    );
    const now = new Date('2026-10-04T12:00:00Z');
    await svc.raise(input(60), now);
    Object.assign(prisma.rows[0]!, { status: 'RESOLVED', resolvedAt: now });
    const later = new Date(now.getTime() + 3_600_000);
    expect(await svc.raise(input(90), later)).toBeNull();
    expect(prisma.rows).toHaveLength(1);
    expect(await svc.raise(input(130), later)).not.toBeNull();
    expect(prisma.rows).toHaveLength(2);
    // Outside the suppression window a new alert may open at the same level.
    Object.assign(prisma.rows[1]!, { status: 'DISMISSED', resolvedAt: later });
    expect(await svc.raise(input(60), new Date(later.getTime() + 25 * 3_600_000))).not.toBeNull();
  });
});
