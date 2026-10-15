import * as crypto from 'node:crypto';

// Pass-through mock: the real CSPRNG unless a test overrides one call.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomInt: jest.fn(actual.randomInt) };
});
const randomInt = crypto.randomInt as unknown as jest.Mock;
import {
  ACTIVATION_PIN_ALPHABET,
  BASE62_ALPHABET,
  HELMET_CODE_ALPHABET,
  HELMET_CODE_REGEX,
  isAcceptedActivationPin,
  isSafetyIdPin,
  isValidHelmetCode,
  isValidPublicToken,
  PUBLIC_TOKEN_LENGTH,
} from '@helmet/types';
import { entropyBits } from './secure-random';
import {
  buildSerialNumber,
  generateLegacyActivationPin,
  generateSafetyIdPin,
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

describe('generateSafetyIdPin (Phase 9 final format)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    randomInt.mockClear();
  });

  it('is exactly six numeric digits, always a string', () => {
    for (let i = 0; i < 5000; i++) {
      const pin = generateSafetyIdPin();
      expect(typeof pin).toBe('string');
      expect(pin).toMatch(/^[0-9]{6}$/);
      expect(isSafetyIdPin(pin)).toBe(true);
    }
  });

  it('keeps leading zeros (004281, 000000, 000017)', () => {
    randomInt.mockReturnValueOnce(4281).mockReturnValueOnce(0).mockReturnValueOnce(17);
    expect(generateSafetyIdPin()).toBe('004281');
    expect(generateSafetyIdPin()).toBe('000000');
    expect(generateSafetyIdPin()).toBe('000017');
  });

  it('draws from the CSPRNG over the full 000000–999999 range, never Math.random', () => {
    const random = jest.spyOn(Math, 'random');
    generateSafetyIdPin();
    expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
    expect(random).not.toHaveBeenCalled();
  });

  it('is uniform: every digit position passes a chi-square test', () => {
    const N = 60_000;
    const counts = Array.from({ length: 6 }, () => new Array<number>(10).fill(0));
    for (let i = 0; i < N; i++) {
      const pin = generateSafetyIdPin();
      for (let p = 0; p < 6; p++) counts[p]![Number(pin[p])]! += 1;
    }
    const expected = N / 10;
    for (const position of counts) {
      const chi = position.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
      // 9 degrees of freedom: p = 0.0001 critical value ≈ 33.7.
      expect(chi).toBeLessThan(33.7);
    }
  });
});

describe('generateLegacyActivationPin (Phase 1–8, still verifiable)', () => {
  it('is 8 symbols from the unambiguous alphabet', () => {
    const allowed = new RegExp(`^[${ACTIVATION_PIN_ALPHABET}]{8}$`);
    for (let i = 0; i < 1000; i++) expect(generateLegacyActivationPin()).toMatch(allowed);
  });

  it('is accepted by the activation format check alongside six-digit PINs', () => {
    expect(isAcceptedActivationPin(generateLegacyActivationPin())).toBe(true);
    expect(isAcceptedActivationPin('146628')).toBe(true);
    expect(isAcceptedActivationPin('004281')).toBe(true);
    expect(isAcceptedActivationPin('14662')).toBe(false);
    expect(isAcceptedActivationPin('1466280')).toBe(false);
    expect(isAcceptedActivationPin('14662A')).toBe(false);
    expect(isSafetyIdPin('73KP84QX')).toBe(false);
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
