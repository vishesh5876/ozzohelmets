import { addDays, utcDay } from './analytics-aggregation.service';
import { resolveRange } from './analytics-query.service';

const now = new Date('2026-10-04T15:00:00Z');

describe('analytics date ranges (UTC days)', () => {
  it('presets', () => {
    expect(resolveRange('today', undefined, undefined, now)).toEqual({
      from: '2026-10-04',
      to: '2026-10-04',
    });
    expect(resolveRange('7d', undefined, undefined, now)).toEqual({
      from: '2026-09-28',
      to: '2026-10-04',
    });
    expect(resolveRange(undefined, undefined, undefined, now)).toEqual({
      from: '2026-09-05',
      to: '2026-10-04',
    });
  });

  it('custom ranges are ordered, clamped to today and limited to 366 days', () => {
    expect(resolveRange('custom', '2026-09-10', '2026-09-01', now)).toEqual({
      from: '2026-09-01',
      to: '2026-09-10',
    });
    expect(resolveRange('custom', '2026-10-01', '2027-01-01', now)).toEqual({
      from: '2026-10-01',
      to: '2026-10-04',
    });
    expect(resolveRange('custom', '2020-01-01', '2026-10-04', now)).toEqual({
      from: '2025-10-04',
      to: '2026-10-04',
    });
    // Incomplete custom range falls back to 30 days.
    expect(resolveRange('custom', '2026-09-01', undefined, now).from).toBe('2026-09-05');
  });

  it('day helpers cross month and leap boundaries', () => {
    expect(utcDay(new Date('2026-03-01T23:59:59Z'))).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});
