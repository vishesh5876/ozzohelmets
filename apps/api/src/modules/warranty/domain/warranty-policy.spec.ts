import { AppConfigService } from '../../../config/app-config.service';
import {
  addMonths,
  coverage,
  effectiveStatus,
  isoDate,
  replacementCoverage,
  toDate,
  WarrantyPolicyService,
} from './warranty-policy';

const d = toDate;

describe('warranty policy', () => {
  it('adds calendar months, clamping to the end of shorter months', () => {
    expect(isoDate(addMonths(d('2026-01-31'), 1))).toBe('2026-02-28');
    expect(isoDate(addMonths(d('2028-01-31'), 1))).toBe('2028-02-29');
    expect(isoDate(addMonths(d('2026-10-03'), 36))).toBe('2029-10-03');
    expect(isoDate(addMonths(d('2026-11-15'), 3))).toBe('2027-02-15');
  });

  it('coverage ends on the last covered day', () => {
    expect(coverage(d('2026-10-03'), 36)).toEqual({ start: d('2026-10-03'), end: d('2029-10-02') });
    expect(coverage(d('2026-10-03'), 0)).toEqual({ start: d('2026-10-03'), end: d('2026-10-03') });
  });

  it('derives effective status without a cron job', () => {
    const today = d('2027-01-01');
    expect(effectiveStatus(null, today)).toBe('NOT_REGISTERED');
    expect(effectiveStatus({ status: 'ACTIVE', warrantyEndDate: d('2027-01-01') }, today)).toBe(
      'ACTIVE',
    );
    expect(effectiveStatus({ status: 'ACTIVE', warrantyEndDate: d('2026-12-31') }, today)).toBe(
      'EXPIRED',
    );
    expect(effectiveStatus({ status: 'EXPIRED', warrantyEndDate: d('2028-01-01') }, today)).toBe(
      'ACTIVE',
    );
    expect(effectiveStatus({ status: 'VOID', warrantyEndDate: d('2026-01-01') }, today)).toBe(
      'VOID',
    );
    expect(effectiveStatus({ status: 'REPLACED', warrantyEndDate: d('2030-01-01') }, today)).toBe(
      'REPLACED',
    );
  });

  it('replacement: inherit the original end date by default, new term or override on request', () => {
    const base = {
      originalEnd: d('2029-09-30'),
      linkDate: d('2027-03-01'),
      replacementModelMonths: 24,
    };
    expect(replacementCoverage({ ...base, policy: 'INHERIT_END_DATE' })).toEqual({
      start: d('2027-03-01'),
      end: d('2029-09-30'),
    });
    expect(replacementCoverage({ ...base, policy: 'NEW_TERM' })).toEqual({
      start: d('2027-03-01'),
      end: d('2029-02-28'),
    });
    expect(
      replacementCoverage({ ...base, policy: 'INHERIT_END_DATE', overrideEnd: d('2031-01-01') })
        .end,
    ).toEqual(d('2031-01-01'));
    // Original already expired → zero-length (expired) replacement term, never start > end.
    const expired = replacementCoverage({
      ...base,
      originalEnd: d('2026-01-01'),
      policy: 'INHERIT_END_DATE',
    });
    expect(expired.start <= expired.end).toBe(true);
  });

  describe('WarrantyPolicyService', () => {
    const config = {
      get: (k: string) => (k === 'WARRANTY_PURCHASE_DATE_TOLERANCE_DAYS' ? 1 : 'INHERIT_END_DATE'),
    };
    const service = new WarrantyPolicyService(config as unknown as AppConfigService);
    const made = d('2026-01-01');
    const today = d('2026-10-03');

    it('validates purchase dates (future tolerance, not before manufacturing)', () => {
      expect(() => service.assertPurchaseDate(d('2026-10-04'), made, today)).not.toThrow();
      expect(() => service.assertPurchaseDate(d('2026-10-05'), made, today)).toThrow(/future/);
      expect(() => service.assertPurchaseDate(d('2025-12-31'), made, today)).toThrow(
        /manufactured/,
      );
    });

    it('derives coverage from the model and refuses models without a warranty', () => {
      expect(
        service.coverageFor({ warrantyEnabled: true, warrantyMonths: 24 }, d('2026-10-03')).end,
      ).toEqual(d('2028-10-02'));
      expect(() =>
        service.coverageFor({ warrantyEnabled: false, warrantyMonths: 24 }, today),
      ).toThrow();
      expect(() =>
        service.coverageFor({ warrantyEnabled: true, warrantyMonths: 0 }, today),
      ).toThrow();
    });
  });
});
