import { nextAccountStatus } from './account-status';
import { likeContains, parseCustomerQuery } from './search';

describe('admin customer search parsing', () => {
  it('treats checksum-valid Customer IDs and Helmet IDs as exact lookups', () => {
    expect(parseCustomerQuery('cu-aaaa-aaaq')).toEqual({
      kind: 'customerId',
      code: 'CU-AAAA-AAAQ',
    });
    const helmet = parseCustomerQuery('HM-A8F3-KL92');
    expect(['helmetId']).toContain(helmet.kind);
  });

  it('never fuzzy-matches an ID-shaped query with a typo', () => {
    expect(parseCustomerQuery('CU-AAAA-AAAB').kind).toBe('customerId');
    expect(parseCustomerQuery('HM-ZZZZ-ZZZZ').kind).toBe('helmetId');
  });

  it('uses partial email when the query contains @, text otherwise, and requires 3 chars', () => {
    expect(parseCustomerQuery('Asha@Exam')).toEqual({ kind: 'email', fragment: 'asha@exam' });
    expect(parseCustomerQuery('  Verma ')).toEqual({ kind: 'text', fragment: 'verma' });
    expect(parseCustomerQuery('ab')).toEqual({ kind: 'tooShort' });
    expect(parseCustomerQuery('')).toEqual({ kind: 'all' });
    expect(parseCustomerQuery(undefined)).toEqual({ kind: 'all' });
  });

  it('escapes LIKE wildcards', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('admin account status changes', () => {
  it('allows suspend/lock/restore only from sensible states; DELETED is terminal', () => {
    expect(nextAccountStatus('ACTIVE', 'SUSPEND')).toBe('SUSPENDED');
    expect(nextAccountStatus('ACTIVE', 'LOCK')).toBe('LOCKED');
    expect(nextAccountStatus('SUSPENDED', 'RESTORE')).toBe('ACTIVE');
    expect(nextAccountStatus('LOCKED', 'RESTORE')).toBe('ACTIVE');
    expect(nextAccountStatus('ACTIVE', 'RESTORE')).toBeNull();
    expect(nextAccountStatus('SUSPENDED', 'SUSPEND')).toBeNull();
    for (const a of ['SUSPEND', 'LOCK', 'RESTORE'] as const)
      expect(nextAccountStatus('DELETED', a)).toBeNull();
  });
});
