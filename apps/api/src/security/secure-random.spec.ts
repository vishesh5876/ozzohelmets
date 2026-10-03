import { entropyBits, opaqueToken, secureRandomString } from './secure-random';

describe('secureRandomString', () => {
  it('produces strings of the requested length from the alphabet only', () => {
    for (let i = 0; i < 1000; i++) {
      const s = secureRandomString(16, 'ABC123');
      expect(s).toHaveLength(16);
      expect(s).toMatch(/^[ABC123]+$/);
    }
  });

  it('is approximately uniform (no modulo bias) for a non power-of-two alphabet', () => {
    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 31 symbols: 256 % 31 != 0
    const counts = new Map<string, number>();
    const sample = secureRandomString(310_000, alphabet);
    for (const ch of sample) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const expected = sample.length / alphabet.length;
    // Chi-square with 30 d.o.f.; p=0.0001 critical value ≈ 66.6.
    let chi = 0;
    for (const ch of alphabet) chi += ((counts.get(ch) ?? 0) - expected) ** 2 / expected;
    expect(counts.size).toBe(alphabet.length);
    expect(chi).toBeLessThan(66.6);
  });

  it('rejects invalid parameters', () => {
    expect(() => secureRandomString(0, 'AB')).toThrow(RangeError);
    expect(() => secureRandomString(5, 'A')).toThrow(RangeError);
    expect(() => secureRandomString(1.5, 'AB')).toThrow(RangeError);
  });
});

describe('entropyBits / opaqueToken', () => {
  it('computes entropy', () => {
    expect(entropyBits(8, 256)).toBe(64);
  });

  it('creates 256-bit base64url tokens', () => {
    const token = opaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opaqueToken()).not.toEqual(token);
  });
});
