import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';

const DAY_MS = 86_400_000;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));

/** Redis key for the daily count of unknown/malformed public token requests. */
export const invalidTokenCounterKey = (day: string) => `analytics:invalid-tokens:${day}`;

/**
 * Builds the daily aggregates the dashboards read. Every write is an idempotent
 * `INSERT … ON CONFLICT DO UPDATE` recomputed from source tables, so re-running a day (or two
 * workers racing despite the job lock) converges to the same rows. Aggregates for days whose raw
 * scans were already purged are never zeroed: only rows produced by the SELECT are touched.
 * Synthetic rows are excluded; bot traffic is counted separately from public scans.
 */
@Injectable()
export class AnalyticsAggregationService {
  private readonly logger = new Logger(AnalyticsAggregationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Today + yesterday (late events), plus a one-off backfill when no aggregates exist yet. */
  async aggregateRecent(now = new Date(), backfillDays = 30): Promise<{ days: string[] }> {
    const today = utcDay(now);
    const days = [addDays(today, -1), today];
    const existing = await this.prisma.helmetScanDaily.count({ take: 1 });
    if (existing === 0) {
      const first = await this.prisma.helmetScan.findFirst({
        where: { synthetic: false },
        orderBy: { scannedAt: 'asc' },
        select: { scannedAt: true },
      });
      if (first) {
        const start = utcDay(
          new Date(Math.max(first.scannedAt.getTime(), now.getTime() - backfillDays * DAY_MS)),
        );
        days.length = 0;
        for (let d = start; d <= today; d = addDays(d, 1)) days.push(d);
      }
    }
    for (const day of days) await this.aggregateDay(day, today);
    return { days };
  }

  async aggregateDay(day: string, today = utcDay(new Date())): Promise<void> {
    await this.aggregateHelmetDay(day);
    await this.aggregatePlatformDay(day, day === today);
  }

  async aggregateHelmetDay(day: string): Promise<number> {
    return this.prisma.$executeRaw`
      INSERT INTO helmet_scan_daily (
        id, date, helmet_id, total_scans, emergency_scans, verification_scans, activation_scans,
        bot_scans, unique_ip_hashes, distinct_device_categories, last_scan_at, created_at, updated_at)
      SELECT gen_random_uuid(), ${day}::date, helmet_id,
        count(*) FILTER (WHERE device_category IS DISTINCT FROM 'BOT'),
        count(*) FILTER (WHERE device_category IS DISTINCT FROM 'BOT' AND scan_type = 'EMERGENCY_PAGE'),
        count(*) FILTER (WHERE device_category IS DISTINCT FROM 'BOT' AND scan_type = 'VERIFY'),
        count(*) FILTER (WHERE device_category IS DISTINCT FROM 'BOT' AND scan_type = 'ACTIVATION'),
        count(*) FILTER (WHERE device_category = 'BOT'),
        count(DISTINCT ip_hash) FILTER (WHERE device_category IS DISTINCT FROM 'BOT'),
        count(DISTINCT device_category),
        max(scanned_at), now(), now()
      FROM helmet_scans
      WHERE scanned_at >= (${day}::date::timestamp AT TIME ZONE 'UTC')
        AND scanned_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND synthetic = false
      GROUP BY helmet_id
      ON CONFLICT (helmet_id, date) DO UPDATE SET
        total_scans = EXCLUDED.total_scans,
        emergency_scans = EXCLUDED.emergency_scans,
        verification_scans = EXCLUDED.verification_scans,
        activation_scans = EXCLUDED.activation_scans,
        bot_scans = EXCLUDED.bot_scans,
        unique_ip_hashes = EXCLUDED.unique_ip_hashes,
        distinct_device_categories = EXCLUDED.distinct_device_categories,
        last_scan_at = EXCLUDED.last_scan_at,
        updated_at = now()`;
  }

  async aggregatePlatformDay(day: string, isToday: boolean): Promise<void> {
    const invalid = Number((await this.redis.get(invalidTokenCounterKey(day))) ?? 0);
    await this.prisma.$executeRaw`
      WITH r AS (
        SELECT (${day}::date::timestamp AT TIME ZONE 'UTC') AS s,
               ((${day}::date + 1)::timestamp AT TIME ZONE 'UTC') AS e)
      INSERT INTO platform_daily_stats (
        date, helmets_generated, helmets_activated, new_customers, active_emergency_profiles,
        emergency_scans, verification_scans, unique_helmets_scanned, warranties_registered,
        lost_helmets, stolen_helmets, damaged_helmets, product_reports_created,
        recovery_grants_issued, invalid_token_requests, risk_alerts_opened, updated_at)
      SELECT ${day}::date,
        (SELECT count(*) FROM helmets, r WHERE created_at >= r.s AND created_at < r.e),
        (SELECT count(*) FROM helmets, r WHERE activated_at >= r.s AND activated_at < r.e),
        (SELECT count(*) FROM users, r WHERE created_at >= r.s AND created_at < r.e),
        (SELECT count(*) FROM helmets WHERE status = 'ACTIVE'),
        (SELECT coalesce(sum(emergency_scans), 0) FROM helmet_scan_daily WHERE date = ${day}::date),
        (SELECT coalesce(sum(verification_scans), 0) FROM helmet_scan_daily WHERE date = ${day}::date),
        (SELECT count(*) FROM helmet_scan_daily WHERE date = ${day}::date AND total_scans > 0),
        (SELECT count(*) FROM helmet_warranties, r WHERE registered_at >= r.s AND registered_at < r.e),
        (SELECT count(*) FROM helmet_status_history, r WHERE to_status = 'LOST' AND created_at >= r.s AND created_at < r.e),
        (SELECT count(*) FROM helmet_status_history, r WHERE to_status = 'STOLEN' AND created_at >= r.s AND created_at < r.e),
        (SELECT count(*) FROM helmet_status_history, r WHERE to_status = 'DAMAGED' AND created_at >= r.s AND created_at < r.e),
        (SELECT count(*) FROM product_reports, r WHERE created_at >= r.s AND created_at < r.e),
        (SELECT count(*) FROM account_recovery_grants, r WHERE created_at >= r.s AND created_at < r.e),
        ${invalid},
        (SELECT count(*) FROM risk_alerts, r WHERE created_at >= r.s AND created_at < r.e),
        now()
      ON CONFLICT (date) DO UPDATE SET
        helmets_generated = EXCLUDED.helmets_generated,
        helmets_activated = EXCLUDED.helmets_activated,
        new_customers = EXCLUDED.new_customers,
        -- A snapshot: only "today" tracks the live value; past days keep what they recorded.
        active_emergency_profiles = CASE WHEN ${isToday} THEN EXCLUDED.active_emergency_profiles
                                         ELSE platform_daily_stats.active_emergency_profiles END,
        emergency_scans = EXCLUDED.emergency_scans,
        verification_scans = EXCLUDED.verification_scans,
        unique_helmets_scanned = EXCLUDED.unique_helmets_scanned,
        warranties_registered = EXCLUDED.warranties_registered,
        lost_helmets = EXCLUDED.lost_helmets,
        stolen_helmets = EXCLUDED.stolen_helmets,
        damaged_helmets = EXCLUDED.damaged_helmets,
        product_reports_created = EXCLUDED.product_reports_created,
        recovery_grants_issued = EXCLUDED.recovery_grants_issued,
        -- The Redis counter expires after a week; never lower a value already recorded.
        invalid_token_requests = GREATEST(platform_daily_stats.invalid_token_requests, EXCLUDED.invalid_token_requests),
        risk_alerts_opened = EXCLUDED.risk_alerts_opened,
        updated_at = now()`;
  }
}
