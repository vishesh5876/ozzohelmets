import { normalizeTransferCode, TRANSFER_CODE_REGEX } from '@helmet/types';
import { generateTransferCode, hashTransferCode, sameHash } from './transfer-code';

describe('transfer codes', () => {
  it('are well-formed, high-entropy and unique', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const code = generateTransferCode();
      expect(code).toMatch(TRANSFER_CODE_REGEX);
      codes.add(code);
    }
    expect(codes.size).toBe(5000);
    // 12 symbols from a 31-symbol alphabet.
    expect(12 * Math.log2(31)).toBeGreaterThan(59);
  });

  it('uses every alphabet symbol roughly uniformly', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++)
      for (const ch of generateTransferCode().slice(3).replaceAll('-', ''))
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(31);
    const expected = (4000 * 12) / 31;
    for (const n of counts.values()) expect(Math.abs(n - expected) / expected).toBeLessThan(0.15);
  });

  it('normalises user input', () => {
    const code = generateTransferCode();
    expect(normalizeTransferCode(code.toLowerCase().replaceAll('-', ' '))).toBe(code);
    expect(normalizeTransferCode(code.slice(3))).toBe(code);
    expect(normalizeTransferCode('TR-1111-0000-OOOO')).toBeNull(); // ambiguous symbols
    expect(normalizeTransferCode('short')).toBeNull();
  });

  it('stores only a keyed hash that depends on the server key', () => {
    const code = generateTransferCode();
    const h = hashTransferCode('key-a', code);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(code);
    expect(sameHash(h, hashTransferCode('key-a', code))).toBe(true);
    expect(sameHash(h, hashTransferCode('key-b', code))).toBe(false);
    expect(sameHash(h, hashTransferCode('key-a', generateTransferCode()))).toBe(false);
  });
});
