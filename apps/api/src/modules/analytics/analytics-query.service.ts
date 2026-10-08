import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type AnalyticsOverviewDto,
  type CursorPage,
  type CustomerScanSummaryDto,
  ErrorCode,
  type HelmetActivityItemDto,
  type HelmetAnalyticsDetailDto,
  type HelmetScanEventDto,
  normalizeHelmetCode,
  OPEN_RISK_ALERT_STATUSES,
  type PlatformDailyPointDto,
  type QrIntegrityStatus,
  RISK_SIGNAL_LABELS,
  type RiskLevel,
  type RiskReasonDto,
  type ScanAnalyticsDto,
  type ScanCountsDto,
} from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { effectiveStatus } from '../warranty/domain/warranty-policy';
import { addDays, utcDay } from './analytics-aggregation.service';
import { decodeAnyCursor, decodeCursor, encodeCursor } from './domain/cursor';
import { RiskAlertsService } from './risk-alerts.service';

const DAY_MS = 86_400_000;
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

export interface DateRange {
  from: string;
  to: string;
}

/** Resolves `today | 7d | 30d | custom(from,to)` into inclusive UTC dates (max 366 days). */
export function resolveRange(key: string | undefined, from?: string, to?: string, now = new Date()): DateRange {
  const today = utcDay(now);
  if (key === 'custom' && from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const f = from <= to ? from : to;
    const t = from <= to ? to : from;
    const clampedTo = t > today ? today : t;
    const minFrom = addDays(clampedTo, -365);
    return { from: f < minFrom ? minFrom : f, to: clampedTo };
  }
  if (key === 'today') return { from: today, to: today };
  if (key === '7d') return { from: addDays(today, -6), to: today };
  return { from: addDays(today, -29), to: today };
}

/**
 * Read side of Phase 6 analytics. Past days come from the daily aggregate tables; only *today* is
 * read from the raw scan table (indexed by time). Nothing here reads medical data, contacts, IP
 * hashes or user agents.
 */
@Injectable()
export class AnalyticsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: RiskAlertsService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
  ) {}

  // ─────────────── Overview ───────────────

  async overview(range: DateRange, now = new Date()): Promise<AnalyticsOverviewDto> {
    const today = utcDay(now);
    const todayStart = new Date(`${today}T00:00:00Z`);
    const [counts, warrantyRows, byModel, avgPrint, platform, recent, todayScans] =
      await Promise.all([
        this.prisma.$queryRaw<
          {
            generated: bigint;
            activated: bigint;
            active: bigint;
            profiles: bigint;
            enabled: bigint;
            incomplete: bigint;
            no_contacts: bigint;
            reports: bigint;
            alerts: bigint;
          }[]
        >`
          SELECT
            (SELECT count(*) FROM helmets) AS generated,
            (SELECT count(*) FROM helmets WHERE activated_at IS NOT NULL) AS activated,
            (SELECT count(*) FROM helmets WHERE status = 'ACTIVE') AS active,
            (SELECT count(*) FROM emergency_profiles WHERE helmet_id IS NULL) AS profiles,
            (SELECT count(*) FROM emergency_profiles WHERE helmet_id IS NULL AND emergency_profile_enabled) AS enabled,
            (SELECT count(*) FROM emergency_profiles p WHERE p.helmet_id IS NULL AND (
                coalesce(btrim(p.name), '') = ''
                OR NOT EXISTS (SELECT 1 FROM emergency_contacts c WHERE c.user_id = p.user_id AND c.is_active)
                OR NOT EXISTS (SELECT 1 FROM emergency_visibility v WHERE v.user_id = p.user_id AND v.confirmed_at IS NOT NULL))
            ) AS incomplete,
            (SELECT count(*) FROM helmet_ownerships o WHERE o.status = 'ACTIVE'
               AND NOT EXISTS (SELECT 1 FROM emergency_contacts c WHERE c.user_id = o.user_id AND c.is_active)) AS no_contacts,
            (SELECT count(*) FROM product_reports WHERE status IN ('OPEN', 'REVIEWING')) AS reports,
            (SELECT count(*) FROM risk_alerts WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING')) AS alerts`,
        this.prisma.$queryRaw<{ active: bigint; expired: bigint; registered: bigint; on_activated: bigint; with_proof: bigint }[]>`
          SELECT
            count(*) FILTER (WHERE status IN ('ACTIVE', 'EXPIRED') AND warranty_end_date >= ${today}::date) AS active,
            count(*) FILTER (WHERE status IN ('ACTIVE', 'EXPIRED') AND warranty_end_date < ${today}::date) AS expired,
            count(*) AS registered,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM helmets h WHERE h.id = w.helmet_id AND h.activated_at IS NOT NULL)) AS on_activated,
            count(*) FILTER (WHERE proof_key IS NOT NULL) AS with_proof
          FROM helmet_warranties w`,
        this.prisma.$queryRaw<{ model: string; sku: string; activated: bigint; registered: bigint; active: bigint }[]>`
          SELECT m.name AS model, m.sku,
            count(h.id) FILTER (WHERE h.activated_at IS NOT NULL) AS activated,
            count(w.id) AS registered,
            count(w.id) FILTER (WHERE w.status IN ('ACTIVE', 'EXPIRED') AND w.warranty_end_date >= ${today}::date) AS active
          FROM helmet_models m
          JOIN helmets h ON h.helmet_model_id = m.id
          LEFT JOIN helmet_warranties w ON w.helmet_id = h.id
          GROUP BY m.id ORDER BY activated DESC, m.name LIMIT 20`,
        this.prisma.$queryRaw<{ days: number | null }[]>`
          SELECT avg(extract(epoch FROM (h.activated_at - b.printed_at)) / 86400)::float AS days
          FROM helmets h JOIN helmet_batches b ON b.id = h.batch_id
          WHERE h.activated_at IS NOT NULL AND b.printed_at IS NOT NULL AND h.activated_at >= b.printed_at`,
        this.prisma.platformDailyStats.findMany({
          where: { date: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) } },
          orderBy: { date: 'asc' },
        }),
        this.prisma.helmet.findMany({
          where: { activatedAt: { not: null } },
          orderBy: { activatedAt: 'desc' },
          take: 8,
          select: { id: true, helmetCode: true, activatedAt: true },
        }),
        this.rawScanCounts(todayStart, now),
      ]);
    const c = counts[0]!;
    const w = warrantyRows[0]!;
    const series = this.fillSeries(range, platform, today, todayScans);
    const sum = (k: keyof PlatformDailyPointDto) =>
      series.reduce((acc, p) => acc + (p[k] as number), 0);
    return {
      range,
      current: {
        helmetsGenerated: n(c.generated),
        helmetsActivated: n(c.activated),
        activationRate: rate(n(c.activated), n(c.generated)),
        activeEmergencyProfiles: n(c.active),
        emergencySharingRate: rate(n(c.active), n(c.activated)),
        profilesCreated: n(c.profiles),
        profilesEnabled: n(c.enabled),
        profilesIncomplete: n(c.incomplete),
        ownedHelmetsWithoutContacts: n(c.no_contacts),
        warrantiesActive: n(w.active),
        warrantiesExpired: n(w.expired),
        warrantyRegistrationRate: rate(n(w.on_activated), n(c.activated)),
        proofUploadRate: rate(n(w.with_proof), n(w.registered)),
        openProductReports: n(c.reports),
        openRiskAlerts: n(c.alerts),
        avgDaysPrintedToActivation:
          avgPrint[0]?.days == null ? null : Math.round(avgPrint[0].days * 10) / 10,
      },
      period: {
        helmetsGenerated: sum('helmetsGenerated'),
        helmetsActivated: sum('helmetsActivated'),
        newCustomers: sum('newCustomers'),
        emergencyScans: sum('emergencyScans'),
        verificationScans: sum('verificationScans'),
        warrantiesRegistered: sum('warrantiesRegistered'),
        productReportsCreated: sum('productReportsCreated'),
        riskAlertsOpened: sum('riskAlertsOpened'),
      },
      series,
      warrantyByModel: byModel.map((m) => ({
        model: m.model,
        sku: m.sku,
        activated: n(m.activated),
        registered: n(m.registered),
        active: n(m.active),
      })),
      recentActivations: recent.map((h) => ({
        helmetId: h.id,
        helmetCode: h.helmetCode,
        activatedAt: h.activatedAt!.toISOString(),
      })),
    };
  }

  /** Daily points for every date in range; today's scan counts come from the raw table. */
  private fillSeries(
    range: DateRange,
    rows: { date: Date; [k: string]: unknown }[],
    today: string,
    todayScans: ScanCountsDto,
  ): PlatformDailyPointDto[] {
    const byDate = new Map(rows.map((r) => [utcDay(r.date), r]));
    const out: PlatformDailyPointDto[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      const r = byDate.get(d) as Record<string, number> | undefined;
      out.push({
        date: d,
        helmetsGenerated: r?.helmetsGenerated ?? 0,
        helmetsActivated: r?.helmetsActivated ?? 0,
        newCustomers: r?.newCustomers ?? 0,
        emergencyScans: d === today ? todayScans.emergency : (r?.emergencyScans ?? 0),
        verificationScans: d === today ? todayScans.verify : (r?.verificationScans ?? 0),
        warrantiesRegistered: r?.warrantiesRegistered ?? 0,
        productReportsCreated: r?.productReportsCreated ?? 0,
        riskAlertsOpened: r?.riskAlertsOpened ?? 0,
        invalidTokenRequests: r?.invalidTokenRequests ?? 0,
      });
    }
    return out;
  }

  private async rawScanCounts(from: Date, to: Date, helmetId?: string): Promise<ScanCountsDto> {
    const helmet = helmetId ? Prisma.sql`AND helmet_id = ${helmetId}::uuid` : Prisma.empty;
    const [r] = await this.prisma.$queryRaw<{ e: bigint; v: bigint; t: bigint }[]>`
      SELECT count(*) FILTER (WHERE scan_type = 'EMERGENCY_PAGE') AS e,
             count(*) FILTER (WHERE scan_type = 'VERIFY') AS v,
             count(*) AS t
      FROM helmet_scans
      WHERE scanned_at >= ${from} AND scanned_at <= ${to} AND synthetic = false
        AND device_category IS DISTINCT FROM 'BOT' ${helmet}`;
    return { total: n(r?.t), emergency: n(r?.e), verify: n(r?.v) };
  }

  /** Aggregates for [from, today) + raw for today (if in range). */
  private async scanCounts(from: string, to: string, today: string, now: Date): Promise<ScanCountsDto> {
    const lastAggregated = to < today ? to : addDays(today, -1);
    const [agg] =
      from <= lastAggregated
        ? await this.prisma.$queryRaw<{ e: bigint; v: bigint; t: bigint }[]>`
            SELECT coalesce(sum(emergency_scans), 0) AS e, coalesce(sum(verification_scans), 0) AS v,
                   coalesce(sum(total_scans), 0) AS t
            FROM helmet_scan_daily WHERE date >= ${from}::date AND date <= ${lastAggregated}::date`
        : [{ e: 0n, v: 0n, t: 0n }];
    const live =
      to >= today ? await this.rawScanCounts(new Date(`${today}T00:00:00Z`), now) : { total: 0, emergency: 0, verify: 0 };
    return {
      total: n(agg?.t) + live.total,
      emergency: n(agg?.e) + live.emergency,
      verify: n(agg?.v) + live.verify,
    };
  }

  // ─────────────── Scans ───────────────

  async scans(range: DateRange, now = new Date()): Promise<ScanAnalyticsDto> {
    const today = utcDay(now);
    const [todayC, last7d, last30d, period, uniq, unusual, platform, top] = await Promise.all([
      this.rawScanCounts(new Date(`${today}T00:00:00Z`), now),
      this.scanCounts(addDays(today, -6), today, today, now),
      this.scanCounts(addDays(today, -29), today, today, now),
      this.scanCounts(range.from, range.to, today, now),
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(DISTINCT helmet_id) AS c FROM (
          SELECT helmet_id FROM helmet_scan_daily
            WHERE date >= ${range.from}::date AND date <= ${range.to}::date AND date < ${today}::date AND total_scans > 0
          UNION
          SELECT helmet_id FROM helmet_scans
            WHERE ${range.to}::date >= ${today}::date AND scanned_at >= ${new Date(`${today}T00:00:00Z`)}
              AND synthetic = false AND device_category IS DISTINCT FROM 'BOT') s`,
      this.prisma.helmetRiskAssessment.count({
        where: { riskLevel: { not: 'NONE' }, resolvedAt: null },
      }),
      this.prisma.platformDailyStats.findMany({
        where: { date: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.$queryRaw<
        { helmet_id: string; code: string; model: string; t: bigint; e: bigint; v: bigint; level: RiskLevel | null }[]
      >`
        SELECT d.helmet_id, h.helmet_code AS code, m.name AS model,
               sum(d.total_scans) AS t, sum(d.emergency_scans) AS e, sum(d.verification_scans) AS v,
               a.risk_level AS level
        FROM helmet_scan_daily d
        JOIN helmets h ON h.id = d.helmet_id
        JOIN helmet_models m ON m.id = h.helmet_model_id
        LEFT JOIN helmet_risk_assessments a ON a.helmet_id = d.helmet_id
        WHERE d.date >= ${range.from}::date AND d.date <= ${range.to}::date
        GROUP BY d.helmet_id, h.helmet_code, m.name, a.risk_level
        HAVING sum(d.total_scans) > 0
        ORDER BY t DESC, d.helmet_id LIMIT 10`,
    ]);
    const series = this.fillSeries(range, platform, today, todayC).map((p) => ({
      date: p.date,
      emergency: p.emergencyScans,
      verify: p.verificationScans,
      total: p.emergencyScans + p.verificationScans,
    }));
    return {
      range,
      today: todayC,
      last7d,
      last30d,
      period,
      uniqueHelmetsScannedInPeriod: n(uniq[0]?.c),
      helmetsWithUnusualActivity: unusual,
      invalidTokenRequestsInPeriod: platform.reduce((a, p) => a + p.invalidTokenRequests, 0),
      topHelmets: top.map((t) => ({
        helmetId: t.helmet_id,
        helmetCode: t.code,
        model: t.model,
        scans: n(t.t),
        emergency: n(t.e),
        verify: n(t.v),
        riskLevel: t.level ?? 'NONE',
      })),
      series,
    };
  }

  // ─────────────── Helmet activity (risk list) ───────────────

  async helmetActivity(input: {
    minLevel?: RiskLevel;
    includeResolved?: boolean;
    cursor?: string;
    limit?: number;
  }, now = new Date()): Promise<CursorPage<HelmetActivityItemDto>> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const levels: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const allowed = input.minLevel ? levels.slice(Math.max(levels.indexOf(input.minLevel), 0)) : levels;
    const after = decodeAnyCursor(input.cursor);
    const rows = await this.prisma.helmetRiskAssessment.findMany({
      where: {
        riskLevel: { in: allowed },
        ...(input.includeResolved ? {} : { resolvedAt: null }),
        ...(after && typeof after.s === 'number'
          ? {
              OR: [
                { riskScore: { lt: after.s } },
                { riskScore: after.s, helmetId: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ riskScore: 'desc' }, { helmetId: 'asc' }],
      take: limit + 1,
      include: {
        helmet: {
          select: {
            helmetCode: true,
            status: true,
            qrIntegrityStatus: true,
            helmetModel: { select: { name: true } },
          },
        },
      },
    });
    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.helmetId);
    const today = utcDay(now);
    const [recent, week, alerts] = ids.length
      ? await Promise.all([
          this.prisma.$queryRaw<{ helmet_id: string; c: bigint; last: Date | null }[]>`
            SELECT helmet_id, count(*) FILTER (WHERE scanned_at >= ${new Date(now.getTime() - DAY_MS)}) AS c,
                   max(scanned_at) AS last
            FROM helmet_scans
            WHERE helmet_id = ANY(${ids}::uuid[]) AND scanned_at >= ${new Date(now.getTime() - 7 * DAY_MS)}
              AND synthetic = false AND device_category IS DISTINCT FROM 'BOT'
            GROUP BY helmet_id`,
          this.prisma.$queryRaw<{ helmet_id: string; c: bigint; last: Date | null }[]>`
            SELECT helmet_id, sum(total_scans) AS c, max(last_scan_at) AS last FROM helmet_scan_daily
            WHERE helmet_id = ANY(${ids}::uuid[]) AND date >= ${addDays(today, -6)}::date
            GROUP BY helmet_id`,
          this.prisma.riskAlert.groupBy({
            by: ['helmetId'],
            where: { helmetId: { in: ids }, status: { in: [...OPEN_RISK_ALERT_STATUSES] } },
            _count: { _all: true },
          }),
        ])
      : [[], [], []];
    const r24 = new Map(recent.map((r) => [r.helmet_id, r]));
    const r7 = new Map(week.map((r) => [r.helmet_id, r]));
    const open = new Map(alerts.map((a) => [a.helmetId!, a._count._all]));
    const last = page.at(-1);
    return {
      items: page.map((r) => {
        const lastScan = [r24.get(r.helmetId)?.last, r7.get(r.helmetId)?.last]
          .filter((d): d is Date => !!d)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        return {
          helmetId: r.helmetId,
          helmetCode: r.helmet.helmetCode,
          model: r.helmet.helmetModel.name,
          status: r.helmet.status,
          qrIntegrityStatus: r.helmet.qrIntegrityStatus,
          scans24h: n(r24.get(r.helmetId)?.c),
          scans7d: Math.max(n(r7.get(r.helmetId)?.c), n(r24.get(r.helmetId)?.c)),
          riskLevel: r.riskLevel,
          riskScore: r.riskScore,
          lastScanAt: lastScan?.toISOString() ?? null,
          openAlerts: open.get(r.helmetId) ?? 0,
        };
      }),
      nextCursor: rows.length > limit && last ? encodeCursor({ s: last.riskScore, id: last.helmetId }) : null,
    };
  }

  // ─────────────── Helmet detail ───────────────

  async helmetDetail(rawCode: string, canViewAlerts: boolean, now = new Date()): Promise<HelmetAnalyticsDetailDto> {
    const helmet = await this.findHelmet(rawCode);
    const today = utcDay(now);
    const from30 = addDays(today, -29);
    const [daily, last24, risk, signals, alerts, reports, ownership, todayAgg] = await Promise.all([
      this.prisma.helmetScanDaily.findMany({
        where: { helmetId: helmet.id, date: { gte: new Date(`${from30}T00:00:00Z`), lt: new Date(`${today}T00:00:00Z`) } },
        orderBy: { date: 'asc' },
      }),
      this.rawScanCounts(new Date(now.getTime() - DAY_MS), now, helmet.id),
      this.prisma.helmetRiskAssessment.findUnique({ where: { helmetId: helmet.id } }),
      this.prisma.helmetRiskSignal.findMany({
        where: { helmetId: helmet.id },
        orderBy: [{ status: 'asc' }, { lastDetectedAt: 'desc' }],
        take: 30,
      }),
      canViewAlerts ? this.alerts.list({ helmetId: helmet.id, limit: 20 }) : Promise.resolve(null),
      this.prisma.productReport.findMany({
        where: { helmetId: helmet.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, reason: true, status: true, createdAt: true },
      }),
      this.prisma.helmetOwnership.findFirst({
        where: { helmetId: helmet.id, status: 'ACTIVE' },
        select: { userId: true },
      }),
      this.prisma.$queryRaw<{ t: bigint; e: bigint; v: bigint; u: bigint; last: Date | null }[]>`
        SELECT count(*) AS t, count(*) FILTER (WHERE scan_type = 'EMERGENCY_PAGE') AS e,
               count(*) FILTER (WHERE scan_type = 'VERIFY') AS v, count(DISTINCT ip_hash) AS u,
               max(scanned_at) AS last
        FROM helmet_scans
        WHERE helmet_id = ${helmet.id}::uuid AND scanned_at >= ${new Date(`${today}T00:00:00Z`)}
          AND synthetic = false AND device_category IS DISTINCT FROM 'BOT'`,
    ]);
    const sharing = ownership
      ? ((
          await this.prisma.helmetEmergencySetting.findUnique({
            where: { helmetId_userId: { helmetId: helmet.id, userId: ownership.userId } },
            select: { enabled: true },
          })
        )?.enabled ?? false)
      : false;
    const t = todayAgg[0];
    const byDate = new Map(daily.map((d) => [utcDay(d.date), d]));
    const series: HelmetAnalyticsDetailDto['series'] = [];
    for (let d = from30; d <= today; d = addDays(d, 1)) {
      const r = byDate.get(d);
      series.push(
        d === today
          ? { date: d, total: n(t?.t), emergency: n(t?.e), verify: n(t?.v), uniqueVisitors: n(t?.u) }
          : {
              date: d,
              total: r?.totalScans ?? 0,
              emergency: r?.emergencyScans ?? 0,
              verify: r?.verificationScans ?? 0,
              uniqueVisitors: r?.uniqueIpHashes ?? 0,
            },
      );
    }
    const reasons = (risk?.reasons as unknown as RiskReasonDto[]) ?? [];
    const reports30d = reports.filter((r) => r.createdAt.getTime() >= now.getTime() - 30 * DAY_MS).length;
    const suspicious = reasons.some((r) => r.type !== 'HIGH_SCAN_VOLUME');
    const lastScan = [t?.last, daily.at(-1)?.lastScanAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      helmet: {
        id: helmet.id,
        helmetCode: helmet.helmetCode,
        model: helmet.helmetModel.name,
        sku: helmet.helmetModel.sku,
        status: helmet.status,
        activatedAt: helmet.activatedAt?.toISOString() ?? null,
        emergencySharing: sharing,
        warrantyStatus: effectiveStatus(helmet.warranty),
        qrIntegrityStatus: helmet.qrIntegrityStatus,
        qrIntegrityNote: helmet.qrIntegrityNote,
        qrIntegrityChangedAt: helmet.qrIntegrityChangedAt?.toISOString() ?? null,
      },
      totals: {
        scans24h: last24.total,
        scans30d: series.reduce((a, p) => a + p.total, 0),
        emergency30d: series.reduce((a, p) => a + p.emergency, 0),
        verify30d: series.reduce((a, p) => a + p.verify, 0),
        approxUniqueVisitors7d: series.slice(-7).reduce((a, p) => a + p.uniqueVisitors, 0),
        lastScanAt: lastScan?.toISOString() ?? null,
      },
      series,
      risk: risk
        ? {
            level: risk.riskLevel,
            score: risk.riskScore,
            reasons,
            evaluatedAt: risk.evaluatedAt.toISOString(),
            firstDetectedAt: risk.firstDetectedAt?.toISOString() ?? null,
            lastDetectedAt: risk.lastDetectedAt?.toISOString() ?? null,
            resolvedAt: risk.resolvedAt?.toISOString() ?? null,
            resolutionReason: risk.resolutionReason,
          }
        : null,
      signals: signals.map((s) => ({
        id: s.id,
        type: s.type,
        label: RISK_SIGNAL_LABELS[s.type],
        severity: s.severity,
        status: s.status,
        observedValue: s.observedValue,
        thresholdValue: s.thresholdValue,
        windowStart: s.windowStart.toISOString(),
        windowEnd: s.windowEnd.toISOString(),
        firstDetectedAt: s.firstDetectedAt.toISOString(),
        lastDetectedAt: s.lastDetectedAt.toISOString(),
        clearedAt: s.clearedAt?.toISOString() ?? null,
      })),
      ...(alerts ? { alerts: alerts.items } : {}),
      productReports: {
        total: await this.prisma.productReport.count({ where: { helmetId: helmet.id } }),
        last30d: reports30d,
        recent: reports.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      },
      correlation:
        reports30d > 0 && suspicious
          ? `${reports30d} product report(s) and ${reasons
              .filter((r) => r.type !== 'PRODUCT_REPORT_CORRELATION')
              .map((r) => r.label.toLowerCase())
              .join(', ')}. Review recommended — this does not prove the helmet is counterfeit.`
          : null,
    };
  }

  /** Scan events for forensic drill-down: type, time, device class, cache flag. No IPs. */
  async helmetScans(rawCode: string, cursor?: string, limit = 50): Promise<CursorPage<HelmetScanEventDto>> {
    const helmet = await this.findHelmet(rawCode);
    const take = Math.min(Math.max(limit, 1), 200);
    const after = decodeCursor(cursor);
    const rows = await this.prisma.helmetScan.findMany({
      where: {
        helmetId: helmet.id,
        synthetic: false,
        ...(after
          ? {
              OR: [
                { scannedAt: { lt: new Date(after.t) } },
                { scannedAt: new Date(after.t), id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ scannedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: { id: true, scanType: true, scannedAt: true, deviceCategory: true, cacheHit: true },
    });
    const page = rows.slice(0, take);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({ ...r, scannedAt: r.scannedAt.toISOString() })),
      nextCursor: rows.length > take && last ? encodeCursor({ t: last.scannedAt.toISOString(), id: last.id }) : null,
    };
  }

  // ─────────────── QR integrity (human decision) ───────────────

  async setQrIntegrity(
    admin: AuthenticatedAdmin,
    rawCode: string,
    status: QrIntegrityStatus,
    note: string,
    meta: RequestMeta,
  ): Promise<HelmetAnalyticsDetailDto> {
    const helmet = await this.findHelmet(rawCode);
    await this.prisma.helmet.update({
      where: { id: helmet.id },
      data: { qrIntegrityStatus: status, qrIntegrityNote: note, qrIntegrityChangedAt: new Date() },
    });
    await this.audit.record({
      action: AuditAction.QR_INTEGRITY_CHANGED,
      entityType: 'helmet',
      entityId: helmet.id,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: { from: helmet.qrIntegrityStatus, to: status },
    });
    // The verification page shows a neutral notice for COMPROMISED; emergency access is unchanged.
    await this.cache.invalidate(helmet.publicToken);
    return this.helmetDetail(helmet.helmetCode, true);
  }

  // ─────────────── Customer (owner) summary ───────────────

  async customerSummary(userId: string, helmetId: string, now = new Date()): Promise<CustomerScanSummaryDto> {
    const ownership = await this.prisma.helmetOwnership.findFirst({
      where: { userId, helmetId, status: 'ACTIVE' },
      select: { activatedAt: true },
    });
    if (!ownership) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    // Only scans since THIS owner's ownership began (a previous owner's period is not theirs).
    const since = new Date(Math.max(ownership.activatedAt.getTime(), now.getTime() - 30 * DAY_MS));
    const [r] = await this.prisma.$queryRaw<{ e: bigint; v: bigint; last: Date | null }[]>`
      SELECT count(*) FILTER (WHERE scan_type = 'EMERGENCY_PAGE') AS e,
             count(*) FILTER (WHERE scan_type = 'VERIFY') AS v,
             max(scanned_at) FILTER (WHERE scan_type = 'EMERGENCY_PAGE') AS last
      FROM helmet_scans
      WHERE helmet_id = ${helmetId}::uuid AND scanned_at >= ${since} AND synthetic = false
        AND device_category IS DISTINCT FROM 'BOT'`;
    const total = n(r?.e) + n(r?.v);
    return {
      since: since.toISOString(),
      lastEmergencyScanAt: r?.last?.toISOString() ?? null,
      emergencyScans30d: n(r?.e),
      verificationScans30d: n(r?.v),
      message:
        total === 0
          ? 'Your helmet QR has not been accessed in the last 30 days.'
          : `Your helmet QR was accessed ${total} time${total === 1 ? '' : 's'} in the last 30 days.`,
    };
  }

  private async findHelmet(rawCode: string) {
    const code = normalizeHelmetCode(rawCode);
    const helmet = code
      ? await this.prisma.helmet.findUnique({
          where: { helmetCode: code },
          include: {
            helmetModel: { select: { name: true, sku: true } },
            warranty: { select: { status: true, warrantyEndDate: true } },
          },
        })
      : null;
    if (!helmet)
      throw new AppException(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.', HttpStatus.NOT_FOUND);
    return helmet;
  }
}
