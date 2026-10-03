import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode, type StoredWarrantyStatus, type WarrantyStatus } from '@helmet/types';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/http/app.exception';

/** Calendar date at UTC midnight (how `@db.Date` columns round-trip). */
export function toDate(isoDate: string): Date {
  return new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayUtc(now = new Date()): Date {
  return toDate(now.toISOString());
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Adds calendar months, clamping to the month's last day (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)),
  );
}

/**
 * Coverage for `months` starting on `start`: the end date is the LAST covered day, i.e. the day
 * before the same calendar day `months` later (3 Oct 2026 + 36 months → 2 Oct 2029).
 */
export function coverage(start: Date, months: number): { start: Date; end: Date } {
  return { start, end: months <= 0 ? start : addDays(addMonths(start, months), -1) };
}

/** Effective status: no record → NOT_REGISTERED; an ACTIVE record past its end date → EXPIRED. */
export function effectiveStatus(
  row: { status: StoredWarrantyStatus; warrantyEndDate: Date } | null,
  today: Date = todayUtc(),
): WarrantyStatus {
  if (!row) return 'NOT_REGISTERED';
  if ((row.status === 'ACTIVE' || row.status === 'EXPIRED') && row.warrantyEndDate < today)
    return 'EXPIRED';
  return row.status === 'EXPIRED' ? 'ACTIVE' : row.status;
}

export type ReplacementPolicy = 'INHERIT_END_DATE' | 'NEW_TERM';

/**
 * Coverage for a replacement helmet. Default (INHERIT_END_DATE): coverage runs from the link date
 * to the ORIGINAL end date — a replacement doesn't extend the warranty. NEW_TERM starts a full
 * model term on the link date. An admin override end date wins over both.
 */
export function replacementCoverage(input: {
  policy: ReplacementPolicy;
  originalEnd: Date;
  linkDate: Date;
  replacementModelMonths: number;
  overrideEnd?: Date;
}): { start: Date; end: Date } {
  const end =
    input.overrideEnd ??
    (input.policy === 'NEW_TERM'
      ? coverage(input.linkDate, input.replacementModelMonths).end
      : input.originalEnd);
  // An already-expired original gives an (expired) zero-length replacement term.
  const start = input.linkDate <= end ? input.linkDate : end;
  return { start, end };
}

/** Single place for warranty date rules; nothing is computed in controllers or the browser. */
@Injectable()
export class WarrantyPolicyService {
  constructor(private readonly config: AppConfigService) {}

  /** Model policy → coverage, or WARRANTY_NOT_AVAILABLE when the model has no warranty. */
  coverageFor(
    model: { warrantyEnabled: boolean; warrantyMonths: number },
    purchaseDate: Date,
  ): { start: Date; end: Date } {
    if (!model.warrantyEnabled || model.warrantyMonths <= 0) {
      throw new AppException(
        ErrorCode.WARRANTY_NOT_AVAILABLE,
        'This helmet model does not include a registrable warranty.',
        HttpStatus.CONFLICT,
      );
    }
    return coverage(purchaseDate, model.warrantyMonths);
  }

  /** Purchase date: not (meaningfully) in the future and not before the helmet was made. */
  assertPurchaseDate(purchaseDate: Date, manufacturedOn: Date, today: Date = todayUtc()): void {
    const latest = addDays(today, this.config.get('WARRANTY_PURCHASE_DATE_TOLERANCE_DAYS'));
    if (Number.isNaN(purchaseDate.getTime()) || purchaseDate > latest) {
      throw new AppException(
        ErrorCode.INVALID_PURCHASE_DATE,
        'The purchase date cannot be in the future.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (purchaseDate < manufacturedOn) {
      throw new AppException(
        ErrorCode.INVALID_PURCHASE_DATE,
        'The purchase date is before this helmet was manufactured.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  replacement(input: Omit<Parameters<typeof replacementCoverage>[0], 'policy'>) {
    return replacementCoverage({
      ...input,
      policy: this.config.get('WARRANTY_REPLACEMENT_POLICY'),
    });
  }
}
