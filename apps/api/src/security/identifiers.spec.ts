import {
  formatHelmetCode,
  HELMET_CODE_ALPHABET,
  isValidHelmetCode,
  helmetCodeCheckSymbol,
  normalizeHelmetCode,
} from '@helmet/types';
import { generateHelmetCode } from './helmet-identity.generator';

describe('helmet code check symbol', () => {
  it('detects every single-symbol substitution', () => {
    for (let n = 0; n < 300; n++) {
      const code = generateHelmetCode();
      const symbols = code.replace(/^HM-|-/g, '');
      for (let pos = 0; pos < symbols.length; pos++) {
        for (const replacement of HELMET_CODE_ALPHABET) {
          if (replacement === symbols[pos]) continue;
          const mutated = symbols.slice(0, pos) + replacement + symbols.slice(pos + 1);
          expect(isValidHelmetCode(formatHelmetCode(mutated))).toBe(false);
        }
      }
    }
  });

  it('detects every adjacent transposition, including with the check symbol', () => {
    for (let n = 0; n < 2000; n++) {
      const symbols = generateHelmetCode().replace(/^HM-|-/g, '');
      for (let pos = 0; pos < symbols.length - 1; pos++) {
        if (symbols[pos] === symbols[pos + 1]) continue;
        const swapped =
          symbols.slice(0, pos) + symbols[pos + 1] + symbols[pos] + symbols.slice(pos + 2);
        expect(isValidHelmetCode(formatHelmetCode(swapped))).toBe(false);
      }
    }
  });

  it('rejects payloads with invalid symbols', () => {
    expect(() => helmetCodeCheckSymbol('ABC0EFG')).toThrow();
  });
});

describe('normalizeHelmetCode', () => {
  it('normalises case, spaces and missing dashes', () => {
    const code = generateHelmetCode();
    const raw = code.replace(/-/g, '').toLowerCase();
    expect(normalizeHelmetCode(raw)).toBe(code);
    expect(normalizeHelmetCode(` ${code.slice(3).replace('-', ' ')} `)).toBe(code);
  });

  it('returns null for malformed input', () => {
    expect(normalizeHelmetCode('HM-1234')).toBeNull();
    expect(normalizeHelmetCode('HM-O0O0-O0O0')).toBeNull();
    expect(normalizeHelmetCode('')).toBeNull();
  });
});
