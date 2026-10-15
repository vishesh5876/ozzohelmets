import { randomInt } from 'node:crypto';
import {
  ACTIVATION_PIN_ALPHABET,
  ACTIVATION_PIN_LENGTH,
  BASE62_ALPHABET,
  formatCustomerCode,
  formatSafetyCode,
  formatHelmetCode,
  HELMET_CODE_ALPHABET,
  HELMET_CODE_RANDOM_LENGTH,
  helmetCodeCheckSymbol,
  PUBLIC_TOKEN_LENGTH,
  SAFETY_ID_PIN_LENGTH,
} from '@helmet/types';
import { secureRandomString } from './secure-random';

/**
 * Generators for the public identifiers printed on/encoded into every helmet.
 * All values come from the CSPRNG; none are derived from database IDs or counters.
 * Uniqueness is ultimately guaranteed by database unique constraints (callers retry on
 * collision), these functions only make collisions astronomically unlikely.
 */

/** `HM-XXXX-XXXY`: 7 random symbols (~34.7 bits) + mod-31 weighted check symbol. */
export function generateHelmetCode(): string {
  const payload = secureRandomString(HELMET_CODE_RANDOM_LENGTH, HELMET_CODE_ALPHABET);
  return formatHelmetCode(payload + helmetCodeCheckSymbol(payload));
}

/** `CU-XXXX-XXXY`: permanent public Customer ID (7 random symbols + check symbol). */
export function generateCustomerCode(): string {
  const payload = secureRandomString(HELMET_CODE_RANDOM_LENGTH, HELMET_CODE_ALPHABET);
  return formatCustomerCode(payload + helmetCodeCheckSymbol(payload));
}

/** Phase 9: `SI-XXXX-XXXY`: Safety ID code (7 random symbols + the same check symbol). */
export function generateSafetyCode(): string {
  const payload = secureRandomString(HELMET_CODE_RANDOM_LENGTH, HELMET_CODE_ALPHABET);
  return formatSafetyCode(payload + helmetCodeCheckSymbol(payload));
}

/** 22 base62 symbols ≈ 131 bits — the only value encoded in the QR URL. */
export function generatePublicToken(): string {
  return secureRandomString(PUBLIC_TOKEN_LENGTH, BASE62_ALPHABET);
}

/**
 * Legacy (Phase 1–8) format: 8 unambiguous symbols ≈ 39.6 bits. No longer used for new Safety
 * IDs; kept so fixtures can create legacy PINs and prove they still verify.
 */
export function generateLegacyActivationPin(): string {
  return secureRandomString(ACTIVATION_PIN_LENGTH, ACTIVATION_PIN_ALPHABET);
}

const SAFETY_ID_PIN_SPACE = 10 ** SAFETY_ID_PIN_LENGTH;

/**
 * Phase 9 final format: exactly six numeric digits, uniform over `000000`–`999999` (≈ 19.9 bits).
 * `crypto.randomInt` draws from the OS CSPRNG with rejection sampling (no modulo bias). Returned
 * as a zero-padded STRING — leading zeros are part of the PIN. The small space is defended by
 * per-Safety-ID, per-IP+Safety-ID and per-IP lockouts (ActivationService).
 */
export function generateSafetyIdPin(): string {
  return String(randomInt(0, SAFETY_ID_PIN_SPACE)).padStart(SAFETY_ID_PIN_LENGTH, '0');
}

/** Serial numbers are manufacturing references (not secrets): `<batchCode>-<6-digit index>`. */
export function buildSerialNumber(batchCode: string, unitIndex: number): string {
  return `${batchCode}-${String(unitIndex).padStart(6, '0')}`;
}
