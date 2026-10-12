/* eslint-disable no-console */
/**
 * Synthetic performance check for Phase 9 (docs/SAFETY-ID.md → "Performance").
 *
 *   DATABASE_URL=postgresql://…/helmet_platform_perf npx dotenv -e ../../.env -- \
 *     ts-node --transpile-only scripts/perf-safety-id.ts [safetyIds=5000] [helmets=1000] [scans=100000]
 *
 * Refuses to run unless the database name ends in `_perf` (it truncates the product tables).
 *  1. Generates a standalone Safety ID batch with the real generation job (chunked, resumable),
 *     streams its CSV and print sheet, then marks it printed (escrow purge).
 *  2. Seeds helmets with linked Safety IDs and 30 days of scans keyed by Safety ID (a few hot
 *     ones), then times the worker jobs and the admin analytics reads.
 * "Queries" counts every SQL statement Prisma sent (query events; parameters are never printed).
 * The public emergency payload is measured against a running API by perf-emergency-payload.ts.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { Response } from 'express';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import {
  AnalyticsQueryService,
  resolveRange,
} from '../src/modules/analytics/analytics-query.service';
import { RetentionService } from '../src/modules/analytics/retention.service';
import { RiskAlertsService } from '../src/modules/analytics/risk-alerts.service';
import { RiskEvaluationService } from '../src/modules/analytics/risk-evaluation.service';
import { ExportsService } from '../src/modules/exports/exports.service';
import { SafetyIdGenerationService } from '../src/modules/safety-ids/generation/safety-id-generation.service';
import { SafetyIdBatchesService } from '../src/modules/safety-ids/safety-id-batches.service';
import { generateHelmetCode, generatePublicToken } from '../src/security/helmet-identity.generator';

const SAFETY_IDS = Number(process.argv[2] ?? 5000);
const HELMETS = Number(process.argv[3] ?? 1000);
const SCANS = Number(process.argv[4] ?? 100_000);

/** Minimal streaming sink standing in for the Express response (counts bytes, honours drain). */
function sink() {
  let bytes = 0;
  const headers: Record<string, string> = {};
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const res = {
    status: () => res,
    setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
    write: (chunk: string | Buffer) => {
      bytes += Buffer.byteLength(chunk);
      return true;
    },
    once: () => res,
    end: () => finish(),
  };
  return { res: res as unknown as Response, done, headers, bytes: () => bytes };
}

async function main(): Promise<void> {
  const db = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  if (!db.endsWith('_perf')) throw new Error(`Refusing to seed non-perf database "${db}"`);
  const counting = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  let queries = 0;
  counting.$on('query', () => queries++);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    results.push({
      step,
      ms: Math.round(performance.now() - t0),
      queries: queries - q0,
      note: note?.(r),
    });
    return r;
  };

  await prisma.$executeRawUnsafe(
    `TRUNCATE risk_alerts, platform_daily_stats, worker_job_runs, helmet_scans, safety_id_batches,
      safety_ids, helmets, helmet_batches, helmet_models, audit_logs CASCADE`,
  );
  const adminRow =
    (await prisma.adminUser.findFirst({ where: { email: 'perf@example.invalid' } })) ??
    (await prisma.adminUser.create({
      data: { name: 'Perf', email: 'perf@example.invalid', passwordHash: 'x', role: 'SUPER_ADMIN' },
    }));
  const admin = {
    id: adminRow.id,
    name: adminRow.name,
    email: adminRow.email,
    role: adminRow.role,
  };
  const meta = { ipHash: null, userAgent: 'perf' };

  // ── 1. Standalone generation, export, print ──
  const generator = app.get(SafetyIdGenerationService, { strict: false });
  const batches = app.get(SafetyIdBatchesService, { strict: false });
  const exportsService = app.get(ExportsService, { strict: false });
  const batch = await prisma.safetyIdBatch.create({
    data: {
      batchCode: 'SID-PERF-00001',
      mode: 'STANDALONE',
      quantity: SAFETY_IDS,
      generationStatus: 'GENERATING',
      generationStartedAt: new Date(),
      createdBy: admin.id,
    },
  });
  await time(
    `generate ${SAFETY_IDS} standalone Safety IDs`,
    () => generator.run(batch.id, admin.id),
    () => '',
  );
  const generated = await prisma.safetyId.count({ where: { batchId: batch.id } });
  const escrowed = await prisma.safetyIdActivationSecret.count({
    where: { safetyIdRef: { batchId: batch.id } },
  });
  const final = await prisma.safetyIdBatch.findUniqueOrThrow({ where: { id: batch.id } });
  results[results.length - 1]!.note =
    `${final.generationStatus}, ${generated} rows, ${escrowed} escrowed PINs`;

  const csv = sink();
  await time(
    'export Safety ID CSV (stream)',
    async () => {
      await exportsService.streamSafetyIdCsv(batch.id, admin, meta, csv.res);
      await csv.done;
    },
    () => `${csv.bytes()} bytes, X-Pins-Included ${csv.headers['x-pins-included']}`,
  );
  const sheet = sink();
  await time(
    'print sheet HTML (stream)',
    async () => {
      await exportsService.streamSafetyIdPrintSheet(batch.id, admin, meta, sheet.res);
      await sheet.done;
    },
    () => `${sheet.bytes()} bytes`,
  );
  await time(
    'mark printed (status + escrow purge)',
    () => batches.markPrinted(batch.id, admin, meta),
    (r) => `${r.printStatus}, escrow left ${r.pinsEscrowed}`,
  );

  // ── 2. Helmets with linked Safety IDs + 30 days of scans ──
  await time('seed helmets + linked Safety IDs', async () => {
    const model = await prisma.helmetModel.create({
      data: { name: 'Perf X', sku: 'PERF-1', brand: 'Ozzo' },
    });
    const hb = await prisma.helmetBatch.create({
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
    const rows = Array.from({ length: HELMETS }, (_, i) => {
      const helmetCode = generateHelmetCode();
      const active = i % 10 < 6;
      return {
        helmetCode,
        safetyCode: helmetCode.replace(/^HM-/, 'SI-'),
        publicToken: generatePublicToken(),
        active,
        activatedAt: active ? new Date(now - (i % 60) * 86_400_000) : null,
        serial: `BAT-PERF-${String(i).padStart(6, '0')}`,
      };
    });
    await prisma.helmet.createMany({
      data: rows.map((r) => ({
        helmetCode: r.helmetCode,
        publicToken: r.publicToken,
        activationPinHash: 'x',
        serialNumber: r.serial,
        helmetModelId: model.id,
        batchId: hb.id,
        status: r.active ? ('ACTIVE' as const) : ('SOLD' as const),
        activatedAt: r.activatedAt,
      })),
    });
    await prisma.safetyId.createMany({
      data: rows.map((r) => ({
        safetyCode: r.safetyCode,
        publicToken: r.publicToken,
        activationPinHash: 'x',
        activationPinUsed: r.active,
        status: r.active ? ('ACTIVE' as const) : ('PRINTED' as const),
        activatedAt: r.activatedAt,
      })),
    });
    await prisma.$executeRaw`
      INSERT INTO safety_id_helmet_links (id, safety_id, helmet_id, reason)
      SELECT gen_random_uuid(), s.id, h.id, 'MANUFACTURED'
      FROM safety_ids s JOIN helmets h ON h.public_token = s.public_token`;
  });
  await time('seed scans', async () => {
    // Background: 30 days of ordinary scans over every Safety ID (standalone ones included).
    const hot = 10;
    const background = SCANS - hot * 120;
    await prisma.$executeRaw`
        INSERT INTO helmet_scans (id, safety_id, helmet_id, scan_type, scanned_at, ip_hash, user_agent, device_category)
        WITH ids AS (SELECT array_agg(id) AS a, count(*)::int AS n FROM safety_ids),
             picks AS (SELECT ids.a[1 + floor(random() * ids.n)::int] AS sid, g FROM ids, generate_series(1, ${background}) g)
        SELECT gen_random_uuid(), p.sid, l.helmet_id,
          (CASE WHEN random() < 0.8 THEN 'EMERGENCY_PAGE' ELSE 'VERIFY' END)::"ScanType",
          now() - (random() * interval '30 days'),
          md5('src' || (random() * 5000)::int) || md5('pad'),
          'Mobile Safari on iOS',
          (CASE WHEN random() < 0.03 THEN 'BOT' ELSE 'MOBILE' END)::"DeviceCategory"
        FROM picks p LEFT JOIN safety_id_helmet_links l ON l.safety_id = p.sid AND l.ended_at IS NULL`;
    // Hot Safety IDs: 120 scans in the last hour from 100 distinct sources, a third verify.
    await prisma.$executeRaw`
        INSERT INTO helmet_scans (id, safety_id, helmet_id, scan_type, scanned_at, ip_hash, user_agent, device_category)
        SELECT gen_random_uuid(), s.id, l.helmet_id,
          (CASE WHEN g % 3 = 0 THEN 'VERIFY' ELSE 'EMERGENCY_PAGE' END)::"ScanType",
          now() - (random() * interval '50 minutes'),
          md5(s.id::text || (g % 100)) || md5('pad'),
          'Chrome on Android', 'MOBILE'::"DeviceCategory"
        FROM (SELECT id FROM safety_ids ORDER BY safety_code LIMIT ${hot}) s
        LEFT JOIN safety_id_helmet_links l ON l.safety_id = s.id AND l.ended_at IS NULL,
        generate_series(1, 120) g`;
  });
  await prisma.$executeRawUnsafe('ANALYZE helmet_scans');
  await prisma.$executeRawUnsafe('ANALYZE safety_ids');
  const scanCount = await prisma.helmetScan.count();

  const aggregation = app.get(AnalyticsAggregationService, { strict: false });
  const risk = app.get(RiskEvaluationService, { strict: false });
  const retention = app.get(RetentionService, { strict: false });
  const query = app.get(AnalyticsQueryService, { strict: false });
  const alerts = app.get(RiskAlertsService, { strict: false });
  const range = resolveRange('30d');

  await time(
    'aggregate: 30-day backfill',
    () => aggregation.aggregateRecent(),
    (r) => `${r.days.length} days`,
  );
  await time('aggregate: steady state (today+yesterday)', () => aggregation.aggregateRecent());
  await time(
    'risk.evaluate (first run)',
    () => risk.evaluate(),
    (r) => JSON.stringify(r),
  );
  await time(
    'risk.evaluate (repeat, dedup)',
    () => risk.evaluate(),
    (r) => `alerts touched ${r.alertsRaised}`,
  );
  await time('retention.cleanup', () => retention.run());
  await time('GET overview 30d', () => query.overview(range));
  await time('GET scans 30d', () => query.scans(range));
  const page = await time(
    'GET QR activity (25)',
    () => query.safetyIdActivity({ limit: 25 }),
    (r) => `${r.items.length} rows`,
  );
  const code = page.items[0]?.safetyCode ?? (await prisma.safetyId.findFirstOrThrow()).safetyCode;
  await time('GET Safety ID analytics detail', () => query.safetyIdDetail(code, true));
  await time('GET Safety ID scans (50)', () => query.safetyIdScans(code, undefined, 50));
  await time(
    'GET risk alerts (25)',
    () => alerts.list({ limit: 25 }),
    (r) => `${r.items.length} rows`,
  );

  const totalSafetyIds = await prisma.safetyId.count();
  const alertCount = await prisma.riskAlert.count();
  console.log(
    `\nDataset: ${totalSafetyIds} Safety IDs (${SAFETY_IDS} standalone, ${HELMETS} helmet-linked), ` +
      `${scanCount} scans, ${alertCount} alerts\n`,
  );
  console.table(results);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
