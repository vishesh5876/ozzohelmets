import { ErrorCode, HELMET_STATUSES, helmetListGroup, ownerActions } from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import { assertOwnerAction, restoreTarget } from './lifecycle-policy';

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as AppException).code;
  }
  return undefined;
};

describe('lifecycle policy', () => {
  it('allows transfer only from ACTIVE/ACTIVATED', () => {
    for (const s of HELMET_STATUSES) {
      const allowed = s === 'ACTIVE' || s === 'ACTIVATED';
      expect(ownerActions(s).includes('TRANSFER')).toBe(allowed);
    }
    for (const s of ['LOST', 'STOLEN', 'DAMAGED', 'DEACTIVATED', 'RECALLED'] as const)
      expect(codeOf(() => assertOwnerAction(s, 'TRANSFER'))).toBe(
        ErrorCode.HELMET_NOT_TRANSFERABLE,
      );
    expect(codeOf(() => assertOwnerAction('REPLACED', 'TRANSFER'))).toBe(ErrorCode.HELMET_REPLACED);
  });

  it('maps repeated or impossible actions to precise domain errors', () => {
    expect(codeOf(() => assertOwnerAction('LOST', 'REPORT_LOST'))).toBe(
      ErrorCode.HELMET_ALREADY_LOST,
    );
    expect(codeOf(() => assertOwnerAction('STOLEN', 'REPORT_STOLEN'))).toBe(
      ErrorCode.HELMET_ALREADY_STOLEN,
    );
    expect(codeOf(() => assertOwnerAction('ACTIVE', 'MARK_FOUND'))).toBe(ErrorCode.HELMET_NOT_LOST);
    expect(codeOf(() => assertOwnerAction('LOST', 'MARK_RECOVERED'))).toBe(
      ErrorCode.HELMET_NOT_STOLEN,
    );
    expect(codeOf(() => assertOwnerAction('DEACTIVATED', 'RETIRE'))).toBe(
      ErrorCode.HELMET_NOT_DEACTIVATABLE,
    );
    expect(codeOf(() => assertOwnerAction('ACTIVE', 'REPORT_LOST'))).toBeUndefined();
  });

  it('restores to ACTIVE only when it was ACTIVE and the profile may still be exposed', () => {
    expect(restoreTarget('ACTIVE', true)).toBe('ACTIVE');
    expect(restoreTarget('ACTIVE', false)).toBe('ACTIVATED');
    expect(restoreTarget('ACTIVATED', true)).toBe('ACTIVATED');
    expect(restoreTarget(null, true)).toBe('ACTIVATED');
  });

  it('groups helmets for "My helmets"', () => {
    expect(helmetListGroup('ACTIVE')).toBe('ACTIVE');
    expect(helmetListGroup('ACTIVATED')).toBe('ACTIVE');
    expect(helmetListGroup('LOST')).toBe('NEEDS_ATTENTION');
    expect(helmetListGroup('DAMAGED')).toBe('NEEDS_ATTENTION');
    expect(helmetListGroup('DEACTIVATED')).toBe('RETIRED');
    expect(helmetListGroup('REPLACED')).toBe('RETIRED');
  });
});
