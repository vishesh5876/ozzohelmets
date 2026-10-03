import { isValidCustomerCode, normalizeCustomerCode, parseAccountIdentifier } from '@helmet/types';
import { generateCustomerCode, generateHelmetCode } from './helmet-identity.generator';

describe('Customer ID', () => {
  it('generates valid, unique, non-sequential codes with a check symbol', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const c = generateCustomerCode();
      expect(isValidCustomerCode(c)).toBe(true);
      codes.add(c);
    }
    expect(codes.size).toBe(5000);
  });

  it('detects every single-symbol substitution', () => {
    const code = generateCustomerCode();
    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const symbols = code.slice(3).replace('-', '');
    for (let i = 0; i < 8; i++)
      for (const ch of alphabet) {
        if (ch === symbols[i]) continue;
        const mutated = symbols.slice(0, i) + ch + symbols.slice(i + 1);
        expect(isValidCustomerCode(`CU-${mutated.slice(0, 4)}-${mutated.slice(4)}`)).toBe(false);
      }
  });

  it('normalises input but requires the CU prefix', () => {
    const code = generateCustomerCode();
    expect(normalizeCustomerCode(code.toLowerCase().replaceAll('-', ' '))).toBe(code);
    expect(normalizeCustomerCode(code.slice(3))).toBeNull();
  });

  it('parses sign-in identifiers: Customer ID or Helmet ID, rejecting typos', () => {
    const customer = generateCustomerCode();
    const helmet = generateHelmetCode();
    expect(parseAccountIdentifier(customer)).toEqual({ kind: 'customer', code: customer });
    expect(parseAccountIdentifier(helmet)).toEqual({ kind: 'helmet', code: helmet });
    expect(parseAccountIdentifier(helmet.slice(3).replace('-', ''))).toEqual({
      kind: 'helmet',
      code: helmet,
    });
    const typo = customer.slice(0, -1) + (customer.endsWith('2') ? '3' : '2');
    expect(parseAccountIdentifier(typo)).toBeNull();
    expect(parseAccountIdentifier('hello')).toBeNull();
  });
});
