import {
  evaluateHelmetSignals,
  type HelmetScanMetrics,
  levelAtLeast,
  maxLevel,
  type RiskThresholds,
  scoreSignals,
} from './risk-rules';

const T: RiskThresholds = {
  highScanHourly: 50,
  highScanDaily: 200,
  uniqueIpHourly: 20,
  ipChurn15m: 10,
  ipChurnMinRatio: 0.8,
  verifyDaily: 30,
  verifyBaselineMultiplier: 5,
};
const quiet: HelmetScanMetrics = {
  scans1h: 3,
  scans24h: 12,
  uniqueIp1h: 2,
  scans15m: 1,
  uniqueIp15m: 1,
  verify24h: 1,
  verifyBaselineDaily: 0.5,
  productReports30d: 0,
};
const types = (m: Partial<HelmetScanMetrics>) =>
  evaluateHelmetSignals({ ...quiet, ...m }, T).map((s) => s.type);
const score = (m: Partial<HelmetScanMetrics>) => scoreSignals(evaluateHelmetSignals({ ...quiet, ...m }, T));

describe('risk rules (deterministic, explainable)', () => {
  it('a normally used helmet produces no signals', () => {
    expect(types({})).toEqual([]);
    expect(score({})).toEqual({ score: 0, level: 'NONE', reasons: [] });
  });

  it('values exactly at a threshold do not fire (strictly greater than)', () => {
    expect(types({ scans1h: 50, scans24h: 200, uniqueIp1h: 20 })).toEqual([]);
  });

  it('high volume alone is LOW, and stays at most MEDIUM even when extreme', () => {
    expect(score({ scans1h: 60 }).level).toBe('LOW');
    const extreme = score({ scans1h: 5000, scans24h: 5000 });
    expect(extreme.level).toBe('MEDIUM');
    expect(extreme.reasons).toHaveLength(1);
    expect(extreme.reasons[0]!.detail).toContain('5000 public scans');
  });

  it('false-positive safety: a real emergency with many responders on one network is not CRITICAL', () => {
    // Crash scene: 80 scans in an hour from a handful of phones (same hospital Wi-Fi / CGNAT).
    const s = score({ scans1h: 80, scans24h: 120, uniqueIp1h: 6, scans15m: 40, uniqueIp15m: 4 });
    expect(levelAtLeast(s.level, 'HIGH')).toBe(false);
  });

  it('false-positive safety: a busy emergency with many distinct responders is at most HIGH, not CRITICAL', () => {
    const s = score({ scans1h: 120, scans24h: 150, uniqueIp1h: 30, scans15m: 30, uniqueIp15m: 25 });
    expect(s.level).not.toBe('CRITICAL');
    expect(s.reasons.map((r) => r.type)).not.toContain('QR_SHARED_OR_COPIED_POSSIBLE');
  });

  it('rapid churn requires a high share of distinct sources, not just volume', () => {
    expect(types({ scans15m: 40, uniqueIp15m: 12 })).not.toContain('RAPID_IP_CHURN');
    expect(types({ scans15m: 14, uniqueIp15m: 12 })).toContain('RAPID_IP_CHURN');
  });

  it('verification activity is compared with the helmet baseline', () => {
    expect(types({ verify24h: 40, verifyBaselineDaily: 20 })).not.toContain('ABNORMAL_VERIFY_ACTIVITY');
    expect(types({ verify24h: 40, verifyBaselineDaily: 2 })).toContain('ABNORMAL_VERIFY_ACTIVITY');
    // No history → baseline floor of 1/day.
    expect(types({ verify24h: 31, verifyBaselineDaily: 0 })).toContain('ABNORMAL_VERIFY_ACTIVITY');
  });

  it('product reports only count alongside a scan-pattern signal', () => {
    expect(types({ productReports30d: 3 })).toEqual([]);
    const s = evaluateHelmetSignals({ ...quiet, scans1h: 60, productReports30d: 5 }, T);
    expect(s.find((x) => x.type === 'PRODUCT_REPORT_CORRELATION')!.weight).toBe(20);
  });

  it('possible copied QR needs a visitor pattern AND corroboration; reaches CRITICAL with several signals', () => {
    const m = { scans1h: 120, scans24h: 300, uniqueIp1h: 40, scans15m: 30, uniqueIp15m: 28, verify24h: 60 };
    expect(types(m)).toContain('QR_SHARED_OR_COPIED_POSSIBLE');
    const s = score(m);
    expect(s.level).toBe('CRITICAL');
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.reasons[0]!.weight).toBeGreaterThanOrEqual(s.reasons.at(-1)!.weight);
    for (const r of s.reasons) {
      expect(r.label).toBeTruthy();
      expect(r.detail).toBeTruthy();
    }
    expect(types({ uniqueIp1h: 40 })).not.toContain('QR_SHARED_OR_COPIED_POSSIBLE');
  });

  it('scoring guards: one signal ≤ MEDIUM; CRITICAL needs ≥ 3 distinct signals; duplicates count once', () => {
    const sig = (type: 'HIGH_SCAN_VOLUME' | 'HIGH_UNIQUE_VISITOR_COUNT' | 'RAPID_IP_CHURN', weight: number) => ({
      type,
      weight,
      observed: 1,
      threshold: 1,
      detail: '',
    });
    expect(scoreSignals([sig('HIGH_SCAN_VOLUME', 90)]).level).toBe('MEDIUM');
    expect(scoreSignals([sig('HIGH_SCAN_VOLUME', 50), sig('HIGH_UNIQUE_VISITOR_COUNT', 50)]).level).toBe('HIGH');
    expect(
      scoreSignals([sig('HIGH_SCAN_VOLUME', 25), sig('HIGH_SCAN_VOLUME', 25), sig('HIGH_SCAN_VOLUME', 25)]),
    ).toMatchObject({ score: 25, level: 'MEDIUM' });
    expect(
      scoreSignals([sig('HIGH_SCAN_VOLUME', 30), sig('HIGH_UNIQUE_VISITOR_COUNT', 30), sig('RAPID_IP_CHURN', 30)]),
    ).toMatchObject({ score: 90, level: 'CRITICAL' });
  });

  it('level helpers', () => {
    expect(maxLevel('LOW', 'HIGH')).toBe('HIGH');
    expect(maxLevel('CRITICAL', 'NONE')).toBe('CRITICAL');
    expect(levelAtLeast('MEDIUM', 'LOW')).toBe(true);
    expect(levelAtLeast('NONE', 'LOW')).toBe(false);
  });
});
