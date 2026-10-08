/* eslint-disable no-console */
/**
 * Synthetic performance check for Phase 6 analytics (docs/ANALYTICS.md → "Performance").
 *
 *   DATABASE_URL=postgresql://…/helmet_platform_perf npx dotenv -e ../../.env -- \
 *     ts-node --transpile-only scripts/perf-analytics.ts [helmets=1000] [scans=100000]
 *
 * Refuses to run unless the database name ends in `_perf`. Seeds helmets and 30 days of scans
 * (with a few deliberately hot/copied-looking helmets), then times the worker jobs and the admin
 * read queries. "Queries" counts every SQL statement Prisma sent (query events; parameters are
 * never printed).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import { AnalyticsQueryService, resolveRange } from '../src/modules/analytics/analytics-query.service';
import { RetentionService } from '../src/modules/analytics/retention.service';
import { RiskAlertsService } from '../src/modules/analytics/risk-alerts.service';
import { RiskEvaluationService } from '../src/modules/analytics/risk-evaluation.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { generateHelmetCode, generatePublicToken } from '../src/security/helmet-identity.generator';
import { WorkerModule } from '../src/worker/worker.module';

const HELMETS = Number(process.argv[2] ?? 1000);
const SCANS = Number(process.argv[3] ?? 100_000);

async function main(): Promise<void> {
  const db = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  if (!db.endsWith('_perf')) throw new Error(`Refusing to seed non-perf database "${db}"`);
  // Same services as the worker, with a Prisma client that emits query events for counting.
  const counting = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  let queries = 0;
  counting.$on('query', () => queries++);
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(PrismaService)
    .useValue(counting)
    .compile();
  moduleRef.useLogger(['error']);
  const app = await moduleRef.init();
  const prisma = counting as unknown as PrismaService;
  const results: { step: string; ms: number; queries: number; note?: string }[] = [];
  const time = async <T>(step: string, fn: () => Promise<T>, note?: (r: T) => string) => {
    const q0 = queries;
    const t0 = performance.now();
    const r = await fn();
    results.push({ step, ms: Math.round(performance.now() - t0), queries: queries - q0, note: note?.(r) });
    return r;
  };

  await prisma.$executeRawUnsafe(
    'TRUNCATE risk_alerts, platform_daily_stats, worker_job_runs, helmet_scans, helmets, helmet_batches, helmet_models CASCADE',
  );
  await time('seed helmets', async () => {
    const model = await prisma.helmetModel.create({ data: { name: 'Perf X', sku: 'PERF-1', brand: 'Ozzo' } });
    const batch = await prisma.helmetBatch.create({
      data: {
        batchCode: 'BAT-PERF',
        helmetModelId: model.id,
        manufacturingDate: new Date('2026-01-01'),
        quantity: HELMETS,
        generatedCount: HELMETS,
        generationStatus: 'COMPLETED',
        printStatus: 'PRINTED',
        printedAt: new Date('2026-02-01'),
      },
    });
    const now = Date.now();
    await prisma.helmet.createMany({
      data: Array.from({ length: HELMETS }, (_, i) => ({
        helmetCode: generateHelmetCode(),
        publicToken: generatePublicToken(),
        activationPinHash: 'x',
        serialNumber: `BAT-PERF-${String(i).padStart(6, '0')}`,
        helmetModelId: model.id,
        batchId: batch.id,
        status: i % 10 < 6 ? ('ACTIVE' as const) : ('SOLD' as const),
        activatedAt: i % 10 < 6 ? new Date(now - (i % 60) * 86_400_000) : null,
      })),
    });
  });
  await time(
    'seed scans',
    async () => {
      // Background: 30 days of ordinary scans spread over all helmets and ~5k sources.
      const hot = 10;
      const background = SCANS - hot * 120;
      await prisma.$executeRaw`
        INSERT INTO helmet_scans (id, helmet_id, scan_type, scanned_at, ip_hash, user_agent, device_category)
        WITH ids AS (SELECT array_agg(id) AS a, count(*)::int AS n FROM helmets)
        SELECT gen_random_uuid(), ids.a[1 + floor(random() * ids.n)::int],
          (CASE WHEN random() < 0.8 THEN 'EMERGENCY_PAGE' ELSE 'VERIFY' END)::"ScanType",
          now() - (random() * interval '30 days'),
          md5('src' || (random() * 5000)::int) || md5('pad'),
          'Mobile Safari on iOS',
          (CASE WHEN random() < 0.03 THEN 'BOT' ELSE 'MOBILE' END)::"DeviceCategory"
        FROM generate_series(1, ${background}) g, ids`;
      // Hot helmets: 120 scans in the last hour from 100 distinct sources, a third of them verify.
      await prisma.$executeRaw`
        INSERT INTO helmet_scans (id, helmet_id, scan_type, scanned_at, ip_hash, user_agent, device_category)
        SELECT gen_random_uuid(), h.id,
          (CASE WHEN g % 3 = 0 THEN 'VERIFY' ELSE 'EMERGENCY_PAGE' END)::"ScanType",
          now() - (random() * interval '50 minutes'),
          md5(h.id::text || (g % 100)) || md5('pad'),
          'Chrome on Android', 'MOBILE'::"DeviceCategory"
        FROM (SELECT id FROM helmets ORDER BY helmet_code LIMIT ${hot}) h, generate_series(1, 120) g`;
    },
  );
  await prisma.$executeRawUnsafe('ANALYZE helmet_scans');
  const count = await prisma.helmetScan.count();

  const aggregation = app.get(AnalyticsAggregationService);
  const risk = app.get(RiskEvaluationService);
  const retention = app.get(RetentionService);
  const query = app.get(AnalyticsQueryService);
  const alerts = app.get(RiskAlertsService);
  const range = resolveRange('30d');

  await time('aggregate: 30-day backfill', () => aggregation.aggregateRecent(), (r) => `${r.days.length} days`);
  await time('aggregate: steady state (today+yesterday)', () => aggregation.aggregateRecent());
  await time('risk.evaluate (first run)', () => risk.evaluate(), (r) => JSON.stringify(r));
  await time('risk.evaluate (repeat, dedup)', () => risk.evaluate(), (r) => `alerts touched ${r.alertsRaised}`);
  await time('retention.cleanup', () => retention.run());
  await time('GET overview 30d', () => query.overview(range));
  await time('GET scans 30d', () => query.scans(range));
  const page = await time('GET helmet activity (25)', () => query.helmetActivity({ limit: 25 }), (r) => `${r.items.length} rows`);
  const code = page.items[0]?.helmetCode ?? (await prisma.helmet.findFirstOrThrow()).helmetCode;
  await time('GET helmet detail', () => query.helmetDetail(code, true));
  await time('GET helmet scans (50)', () => query.helmetScans(code, undefined, 50));
  await time('GET risk alerts (25)', () => alerts.list({ limit: 25 }), (r) => `${r.items.length} rows`);

  const alertCount = await prisma.riskAlert.count();
  console.log(`\nDataset: ${HELMETS} helmets, ${count} scans, ${alertCount} alerts\n`);
  console.table(results);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
