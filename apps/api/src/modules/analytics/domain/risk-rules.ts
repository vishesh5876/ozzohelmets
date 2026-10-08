import {
  type RiskLevel,
  type RiskReasonDto,
  RISK_SIGNAL_LABELS,
  type RiskSignalType,
} from '@helmet/types';

/** Configurable thresholds (see RISK-ENGINE.md for defaults and rationale). */
export interface RiskThresholds {
  highScanHourly: number;
  highScanDaily: number;
  uniqueIpHourly: number;
  ipChurn15m: number;
  ipChurnMinRatio: number;
  verifyDaily: number;
  verifyBaselineMultiplier: number;
}

/** Per-helmet facts for one evaluation. Scan metadata, lifecycle and reports only — no medical data. */
export interface HelmetScanMetrics {
  scans1h: number;
  scans24h: number;
  uniqueIp1h: number;
  scans15m: number;
  uniqueIp15m: number;
  verify24h: number;
  /** Average daily verification scans over the previous 7 days. */
  verifyBaselineDaily: number;
  productReports30d: number;
}

export interface ObservedSignal {
  type: RiskSignalType;
  severity: RiskLevel;
  observed: number;
  threshold: number;
  weight: number;
  window: '15m' | '1h' | '24h' | '30d';
  detail: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Deterministic rules. Each returned signal explains itself (observed vs threshold). Volume alone
 * is LOW/MEDIUM: a real emergency can produce many scans.
 */
export function evaluateHelmetSignals(m: HelmetScanMetrics, t: RiskThresholds): ObservedSignal[] {
  const out: ObservedSignal[] = [];
  const hourlyRatio = m.scans1h / t.highScanHourly;
  const dailyRatio = m.scans24h / t.highScanDaily;
  if (m.scans1h > t.highScanHourly || m.scans24h > t.highScanDaily) {
    const hourly = hourlyRatio >= dailyRatio;
    const strong = Math.max(hourlyRatio, dailyRatio) >= 2;
    out.push({
      type: 'HIGH_SCAN_VOLUME',
      severity: strong ? 'MEDIUM' : 'LOW',
      observed: hourly ? m.scans1h : m.scans24h,
      threshold: hourly ? t.highScanHourly : t.highScanDaily,
      weight: strong ? 25 : 15,
      window: hourly ? '1h' : '24h',
      detail: hourly
        ? `${m.scans1h} public scans in 1 hour (threshold ${t.highScanHourly})`
        : `${m.scans24h} public scans in 24 hours (threshold ${t.highScanDaily})`,
    });
  }
  if (m.uniqueIp1h > t.uniqueIpHourly)
    out.push({
      type: 'HIGH_UNIQUE_VISITOR_COUNT',
      severity: 'MEDIUM',
      observed: m.uniqueIp1h,
      threshold: t.uniqueIpHourly,
      weight: 25,
      window: '1h',
      detail: `${m.uniqueIp1h} distinct visitor hashes in 1 hour (threshold ${t.uniqueIpHourly})`,
    });
  const churnRatio = m.scans15m > 0 ? m.uniqueIp15m / m.scans15m : 0;
  if (m.uniqueIp15m > t.ipChurn15m && churnRatio >= t.ipChurnMinRatio)
    out.push({
      type: 'RAPID_IP_CHURN',
      severity: 'MEDIUM',
      observed: m.uniqueIp15m,
      threshold: t.ipChurn15m,
      weight: 20,
      window: '15m',
      detail: `${m.uniqueIp15m} distinct visitor hashes in 15 minutes, ${Math.round(churnRatio * 100)}% of scans from different sources`,
    });
  const baseline = Math.max(m.verifyBaselineDaily, 1);
  if (m.verify24h > t.verifyDaily && m.verify24h > baseline * t.verifyBaselineMultiplier)
    out.push({
      type: 'ABNORMAL_VERIFY_ACTIVITY',
      severity: 'MEDIUM',
      observed: m.verify24h,
      threshold: t.verifyDaily,
      weight: 20,
      window: '24h',
      detail: `${m.verify24h} verification scans in 24 hours, ${round(m.verify24h / baseline)}× the 7-day daily baseline (${round(m.verifyBaselineDaily)})`,
    });
  // Correlations only count alongside at least one scan-pattern signal.
  if (out.length > 0 && m.productReports30d > 0)
    out.push({
      type: 'PRODUCT_REPORT_CORRELATION',
      severity: 'LOW',
      observed: m.productReports30d,
      threshold: 1,
      weight: Math.min(m.productReports30d, 2) * 10,
      window: '30d',
      detail: `${m.productReports30d} product report(s) in 30 days`,
    });
  const visitorPattern = out.some(
    (s) => s.type === 'HIGH_UNIQUE_VISITOR_COUNT' || s.type === 'RAPID_IP_CHURN',
  );
  const corroboration = out.some(
    (s) => s.type === 'ABNORMAL_VERIFY_ACTIVITY' || s.type === 'PRODUCT_REPORT_CORRELATION',
  );
  if (visitorPattern && corroboration)
    out.push({
      type: 'QR_SHARED_OR_COPIED_POSSIBLE',
      severity: 'HIGH',
      observed: 1,
      threshold: 1,
      weight: 20,
      window: '24h',
      detail: 'Many distinct visitors together with unusual verification activity or product reports',
    });
  return out;
}

export interface RiskScore {
  score: number;
  level: RiskLevel;
  reasons: RiskReasonDto[];
}

/**
 * Explainable score: the sum of signal weights (cap 100) mapped to a level, with two guards — a
 * single signal never exceeds MEDIUM, and CRITICAL needs at least three distinct signals.
 */
export function scoreSignals(signals: Omit<ObservedSignal, 'window' | 'severity'>[]): RiskScore {
  const distinct = new Map<RiskSignalType, (typeof signals)[number]>();
  for (const s of signals) {
    const prev = distinct.get(s.type);
    if (!prev || s.weight > prev.weight) distinct.set(s.type, s);
  }
  const list = [...distinct.values()];
  const score = Math.min(
    100,
    list.reduce((n, s) => n + s.weight, 0),
  );
  let level: RiskLevel =
    score === 0 ? 'NONE' : score < 25 ? 'LOW' : score < 50 ? 'MEDIUM' : score < 75 ? 'HIGH' : 'CRITICAL';
  if (list.length <= 1 && (level === 'HIGH' || level === 'CRITICAL')) level = 'MEDIUM';
  if (level === 'CRITICAL' && list.length < 3) level = 'HIGH';
  return {
    score,
    level,
    reasons: list
      .sort((a, b) => b.weight - a.weight)
      .map((s) => ({
        type: s.type,
        label: RISK_SIGNAL_LABELS[s.type],
        observed: s.observed,
        threshold: s.threshold,
        weight: s.weight,
        detail: s.detail,
      })),
  };
}

const ORDER: RiskLevel[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
export const levelAtLeast = (a: RiskLevel, b: RiskLevel) => ORDER.indexOf(a) >= ORDER.indexOf(b);
