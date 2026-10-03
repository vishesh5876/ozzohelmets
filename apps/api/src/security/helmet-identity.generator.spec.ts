import {
  ACTIVATION_PIN_ALPHABET,
  BASE62_ALPHABET,
  HELMET_CODE_ALPHABET,
  HELMET_CODE_REGEX,
  isValidHelmetCode,
  isValidPublicToken,
  PUBLIC_TOKEN_LENGTH,
} from '@helmet/types';
import { entropyBits } from './secure-random';
import {
  buildSerialNumber,
  generateActivationPin,
  generateHelmetCode,
  generatePublicToken,
} from './helmet-identity.generator';

const SAMPLE = 100_000;

describe('generateHelmetCode', () => {
  it('matches HM-XXXX-XXXX with a valid check symbol', () => {
    for (let i = 0; i < 10_000; i++) {
      const code = generateHelmetCode();
      expect(code).toMatch(HELMET_CODE_REGEX);
      expect(isValidHelmetCode(code)).toBe(true);
    }
  });

  it(`generates ${SAMPLE.toLocaleString()} unique codes`, () => {
    const codes = new Set<string>();
    for (let i = 0; i < SAMPLE; i++) codes.add(generateHelmetCode());
    // 31^7 ≈ 2.75e10 space: expected collisions for 1e5 draws ≈ 0.18; allow a couple.
    expect(codes.size).toBeGreaterThanOrEqual(SAMPLE - 2);
  });

  it('is not sequential (generation order is unrelated to lexical order)', () => {
    const codes = Array.from({ length: 1000 }, generateHelmetCode);
    const sorted = [...codes].sort();
    const inPlace = codes.filter((c, i) => sorted[i] === c).length;
    expect(inPlace).toBeLessThan(20);
  });

  it('never uses ambiguous characters', () => {
    const joined = Array.from({ length: 2000 }, generateHelmetCode).join('').replace(/HM-|-/g, '');
    expect(joined).not.toMatch(/[01OIL]/);
  });
});

describe('generatePublicToken', () => {
  it('carries at least 128 bits of entropy', () => {
    expect(entropyBits(PUBLIC_TOKEN_LENGTH, BASE62_ALPHABET.length)).toBeGreaterThanOrEqual(128);
  });

  it('is URL-safe base62 of the expected length', () => {
    for (let i = 0; i < 1000; i++) {
      const token = generatePublicToken();
      expect(isValidPublicToken(token)).toBe(true);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it(`generates ${SAMPLE.toLocaleString()} unique tokens`, () => {
    const tokens = new Set<string>();
    for (let i = 0; i < SAMPLE; i++) tokens.add(generatePublicToken());
    expect(tokens.size).toBe(SAMPLE);
  });
});

describe('generateActivationPin', () => {
  it('is 8 symbols from the unambiguous alphabet', () => {
    const allowed = new RegExp(`^[${ACTIVATION_PIN_ALPHABET}]{8}$`);
    for (let i = 0; i < 1000; i++) expect(generateActivationPin()).toMatch(allowed);
  });

  it('is effectively unique', () => {
    const pins = new Set(Array.from({ length: 20_000 }, generateActivationPin));
    expect(pins.size).toBeGreaterThanOrEqual(19_999);
  });

  it('uses the same alphabet as helmet codes', () => {
    expect(ACTIVATION_PIN_ALPHABET).toBe(HELMET_CODE_ALPHABET);
  });
});

describe('buildSerialNumber', () => {
  it('pads the unit index', () => {
    expect(buildSerialNumber('BAT-2026-00045', 7)).toBe('BAT-2026-00045-000007');
  });
});
