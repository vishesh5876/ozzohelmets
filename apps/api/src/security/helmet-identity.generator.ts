import {
  ACTIVATION_PIN_ALPHABET,
  ACTIVATION_PIN_LENGTH,
  BASE62_ALPHABET,
  formatHelmetCode,
  HELMET_CODE_ALPHABET,
  HELMET_CODE_RANDOM_LENGTH,
  luhnModNCheckSymbol,
  PUBLIC_TOKEN_LENGTH,
} from '@helmet/types';
import { secureRandomString } from './secure-random';

/**
 * Generators for the public identifiers printed on/encoded into every helmet.
 * All values come from the CSPRNG; none are derived from database IDs or counters.
 * Uniqueness is ultimately guaranteed by database unique constraints (callers retry on
 * collision), these functions only make collisions astronomically unlikely.
 */

/** `HM-XXXX-XXXY`: 7 random symbols (~34.7 bits) + Luhn mod 31 check symbol. */
export function generateHelmetCode(): string {
  const payload = secureRandomString(HELMET_CODE_RANDOM_LENGTH, HELMET_CODE_ALPHABET);
  return formatHelmetCode(payload + luhnModNCheckSymbol(payload));
}

/** 22 base62 symbols ≈ 131 bits — the only value encoded in the QR URL. */
export function generatePublicToken(): string {
  return secureRandomString(PUBLIC_TOKEN_LENGTH, BASE62_ALPHABET);
}

/** 8 unambiguous symbols ≈ 39.6 bits; online guessing is rate-limited and attempt-capped. */
export function generateActivationPin(): string {
  return secureRandomString(ACTIVATION_PIN_LENGTH, ACTIVATION_PIN_ALPHABET);
}

/** Serial numbers are manufacturing references (not secrets): `<batchCode>-<6-digit index>`. */
export function buildSerialNumber(batchCode: string, unitIndex: number): string {
  return `${batchCode}-${String(unitIndex).padStart(6, '0')}`;
}
