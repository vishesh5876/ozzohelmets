import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { RiskLevel, RiskSignalType } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  evaluateHelmetSignals,
  type HelmetScanMetrics,
  levelAtLeast,
  type ObservedSignal,
  type RiskThresholds,
  scoreSignals,
} from './domain/risk-rules';
import { RiskAlertsService } from './risk-alerts.service';

const HOUR = 3_600_000;
const WINDOW_MS: Record<ObservedSignal['window'], number> = {
  '15m': 15 * 60_000,
  '1h': HOUR,
  '24h': 24 * HOUR,
  '30d': 30 * 24 * HOUR,
};
const VOLUME_ONLY: RiskSignalType[] = ['HIGH_SCAN_VOLUME', 'PRODUCT_REPORT_CORRELATION'];

export interface EvaluationResult {
  candidates: number;
  signalsUpserted: number;
  signalsCleared: number;
  assessmentsUpdated: number;
  alertsRaised: number;
}

/**
 * Deterministic risk evaluation over scan metadata, lifecycle and product reports — never medical
 * data. Writes explainable signals and assessments and raises deduplicated alerts. It never
 * changes HelmetStatus, QR integrity or public availability.
 */
@Injectable()
export class RiskEvaluationService {
  private readonly logger = new Logger(RiskEvaluationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly alerts: RiskAlertsService,
  ) {}

  thresholds(): RiskThresholds {
    return {
      highScanHourly: this.config.get('RISK_HIGH_SCAN_HOURLY'),
      highScanDaily: this.config.get('RISK_HIGH_SCAN_DAILY'),
      uniqueIpHourly: this.config.get('RISK_UNIQUE_IP_HOURLY'),
      ipChurn15m: this.config.get('RISK_IP_CHURN_15MIN'),
      ipChurnMinRatio: this.config.get('RISK_IP_CHURN_MIN_RATIO'),
      verifyDaily: this.config.get('RISK_VERIFY_DAILY'),
      verifyBaselineMultiplier: this.config.get('RISK_VERIFY_BASELINE_MULTIPLIER'),
    };
  }

  /** One-query metrics for helmets with enough recent public (non-bot, non-synthetic) scans. */
  async collectMetrics(now: Date): Promise<Map<string, HelmetScanMetrics>> {
    const minScans = this.config.get('RISK_MIN_SCANS_FOR_EVALUATION');
    const rows = await this.prisma.$queryRaw<
      {
        helmet_id: string;
        h1: bigint;
        d1: bigint;
        u1: bigint;
        m15: bigint;
        u15: bigint;
        v1: bigint;
      }[]
    >`
      SELECT helmet_id,
        count(*) FILTER (WHERE scanned_at >= ${new Date(now.getTime() - HOUR)}) AS h1,
        count(*) AS d1,
        count(DISTINCT ip_hash) FILTER (WHERE scanned_at >= ${new Date(now.getTime() - HOUR)}) AS u1,
        count(*) FILTER (WHERE scanned_at >= ${new Date(now.getTime() - 15 * 60_000)}) AS m15,
        count(DISTINCT ip_hash) FILTER (WHERE scanned_at >= ${new Date(now.getTime() - 15 * 60_000)}) AS u15,
        count(*) FILTER (WHERE scan_type = 'VERIFY') AS v1
      FROM helmet_scans
      WHERE scanned_at >= ${new Date(now.getTime() - 24 * HOUR)} AND scanned_at <= ${now}
        AND synthetic = false AND device_category IS DISTINCT FROM 'BOT'
      GROUP BY helmet_id
      HAVING count(*) >= ${minScans}`;
    const ids = rows.map((r) => r.helmet_id);
    const today = now.toISOString().slice(0, 10);
    const [baselines, reports] = ids.length
      ? await Promise.all([
          this.prisma.$queryRaw<{ helmet_id: string; avg: number }[]>`
            SELECT helmet_id, coalesce(sum(verification_scans), 0)::float / 7 AS avg
            FROM helmet_scan_daily
            WHERE helmet_id = ANY(${ids}::uuid[])
              AND date >= (${today}::date - 7) AND date < ${today}::date
            GROUP BY helmet_id`,
          this.prisma.productReport.groupBy({
            by: ['helmetId'],
            where: {
              helmetId: { in: ids },
              createdAt: { gte: new Date(now.getTime() - 30 * 24 * HOUR) },
            },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const baseline = new Map(baselines.map((b) => [b.helmet_id, Number(b.avg)]));
    const reportCount = new Map(reports.map((r) => [r.helmetId!, r._count._all]));
    return new Map(
      rows.map((r) => [
        r.helmet_id,
        {
          scans1h: Number(r.h1),
          scans24h: Number(r.d1),
          uniqueIp1h: Number(r.u1),
          scans15m: Number(r.m15),
          uniqueIp15m: Number(r.u15),
          verify24h: Number(r.v1),
          verifyBaselineDaily: baseline.get(r.helmet_id) ?? 0,
          productReports30d: reportCount.get(r.helmet_id) ?? 0,
        },
      ]),
    );
  }

  async evaluate(now = new Date()): Promise<EvaluationResult> {
    const t = this.thresholds();
    const metrics = await this.collectMetrics(now);
    const result: EvaluationResult = {
      candidates: metrics.size,
      signalsUpserted: 0,
      signalsCleared: 0,
      assessmentsUpdated: 0,
      alertsRaised: 0,
    };
    const touched = new Set<string>();

    for (const [helmetId, m] of metrics) {
      const observed = evaluateHelmetSignals(m, t);
      if (observed.length === 0) continue;
      touched.add(helmetId);
      for (const s of observed) {
        await this.upsertSignal(helmetId, s, now, m);
        result.signalsUpserted++;
      }
    }

    // Signals not re-observed within the clear-after window go quiet.
    const clearBefore = new Date(
      now.getTime() - this.config.get('RISK_SIGNAL_CLEAR_AFTER_HOURS') * HOUR,
    );
    const stale = await this.prisma.helmetRiskSignal.findMany({
      where: { status: 'ACTIVE', lastDetectedAt: { lt: clearBefore } },
      select: { id: true, helmetId: true },
    });
    if (stale.length) {
      await this.prisma.helmetRiskSignal.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { status: 'CLEARED', clearedAt: now },
      });
      result.signalsCleared = stale.length;
      for (const s of stale) touched.add(s.helmetId);
    }

    for (const helmetId of touched) {
      const level = await this.refreshAssessment(helmetId, now);
      result.assessmentsUpdated++;
      if (await this.raiseHelmetAlert(helmetId, level, now)) result.alertsRaised++;
    }
    return result;
  }

  private async upsertSignal(
    helmetId: string,
    s: ObservedSignal,
    now: Date,
    m: HelmetScanMetrics,
  ): Promise<void> {
    const windowStart = new Date(now.getTime() - WINDOW_MS[s.window]);
    // Safe context only: counts. Never IP hashes, user agents or visitor data.
    const metadata = {
      scans1h: m.scans1h,
      scans24h: m.scans24h,
      uniqueVisitors1h: m.uniqueIp1h,
      verify24h: m.verify24h,
      detail: s.detail,
    } satisfies Prisma.InputJsonValue;
    const updated = await this.prisma.helmetRiskSignal.updateMany({
      where: { helmetId, type: s.type, status: 'ACTIVE' },
      data: {
        severity: s.severity,
        windowStart,
        windowEnd: now,
        observedValue: s.observed,
        thresholdValue: s.threshold,
        lastDetectedAt: now,
        metadata,
      },
    });
    if (updated.count === 0) {
      await this.prisma.helmetRiskSignal
        .create({
          data: {
            helmetId,
            type: s.type,
            severity: s.severity,
            windowStart,
            windowEnd: now,
            observedValue: s.observed,
            thresholdValue: s.threshold,
            firstDetectedAt: now,
            lastDetectedAt: now,
            metadata,
          },
        })
        .catch(() => undefined); // concurrent evaluation created it: the partial unique index wins
    }
  }

  /** Recomputes the helmet's assessment from its ACTIVE signals. */
  async refreshAssessment(helmetId: string, now: Date): Promise<RiskLevel> {
    const active = await this.prisma.helmetRiskSignal.findMany({
      where: { helmetId, status: 'ACTIVE' },
    });
    const score = scoreSignals(
      active.map((s) => ({
        type: s.type,
        observed: s.observedValue,
        threshold: s.thresholdValue,
        weight: weightOf(s.type, s.severity, s.observedValue),
        detail: ((s.metadata as { detail?: string } | null)?.detail ?? '') as string,
      })),
    );
    const existing = await this.prisma.helmetRiskAssessment.findUnique({ where: { helmetId } });
    const detected = score.level !== 'NONE';
    const reasons = score.reasons as unknown as Prisma.InputJsonValue;
    await this.prisma.helmetRiskAssessment.upsert({
      where: { helmetId },
      create: {
        helmetId,
        riskLevel: score.level,
        riskScore: score.score,
        reasons,
        evaluatedAt: now,
        firstDetectedAt: detected ? now : null,
        lastDetectedAt: detected ? now : null,
      },
      update: {
        riskLevel: score.level,
        riskScore: score.score,
        reasons,
        evaluatedAt: now,
        ...(detected
          ? { lastDetectedAt: now, ...(existing?.firstDetectedAt ? {} : { firstDetectedAt: now }) }
          : {}),
        // New activity after a human resolution re-opens the assessment.
        ...(detected && existing?.resolvedAt && existing.resolvedAt < now
          ? { resolvedAt: null, resolutionReason: null }
          : {}),
      },
    });
    return score.level;
  }

  /**
   * Helmet alerts: volume-only patterns raise HIGH_PUBLIC_SCAN_VOLUME (LOW/MEDIUM); visitor or
   * verification patterns raise HELMET_SCAN_ANOMALY. Deduplicated and suppressed by RiskAlertsService.
   */
  private async raiseHelmetAlert(helmetId: string, level: RiskLevel, now: Date): Promise<boolean> {
    if (!levelAtLeast(level, 'LOW')) return false;
    const assessment = await this.prisma.helmetRiskAssessment.findUniqueOrThrow({
      where: { helmetId },
      include: { helmet: { select: { helmetCode: true } } },
    });
    const reasons = assessment.reasons as unknown as {
      type: RiskSignalType;
      observed: number;
      threshold: number;
      label: string;
    }[];
    const volumeOnly = reasons.every((r) => VOLUME_ONLY.includes(r.type));
    const top = reasons[0]!;
    const alert = await this.alerts.raise(
      {
        type: volumeOnly ? 'HIGH_PUBLIC_SCAN_VOLUME' : 'HELMET_SCAN_ANOMALY',
        dedupKey: `helmet:${helmetId}:${volumeOnly ? 'volume' : 'anomaly'}`,
        priority: level,
        helmetId,
        summary: `${volumeOnly ? 'High public scan volume' : 'Unusual QR activity'} on ${assessment.helmet.helmetCode} — ${reasons
          .map((r) => r.label.toLowerCase())
          .join(', ')}. Review recommended.`,
        reasons: assessment.reasons as never,
        observedValue: top.observed,
        thresholdValue: top.threshold,
      },
      now,
    );
    return alert !== null;
  }
}

/** Same weights as `evaluateHelmetSignals`, recovered from a stored signal. */
function weightOf(type: RiskSignalType, severity: RiskLevel, observed: number): number {
  switch (type) {
    case 'HIGH_SCAN_VOLUME':
      return severity === 'MEDIUM' ? 25 : 15;
    case 'HIGH_UNIQUE_VISITOR_COUNT':
      return 25;
    case 'RAPID_IP_CHURN':
    case 'ABNORMAL_VERIFY_ACTIVITY':
    case 'QR_SHARED_OR_COPIED_POSSIBLE':
      return 20;
    case 'PRODUCT_REPORT_CORRELATION':
      return Math.min(observed, 2) * 10;
  }
}
