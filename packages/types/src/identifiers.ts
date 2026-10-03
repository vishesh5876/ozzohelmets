/**
 * Public identifier formats. Pure functions only (browser-safe); generation using the
 * CSPRNG lives in the API.
 */

/** Unambiguous uppercase alphabet: no 0/O, 1/I/L. 31 symbols. */
export const HELMET_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const HELMET_CODE_PREFIX = 'HM';
/** Random symbols in a helmet code (excluding the trailing check symbol). */
export const HELMET_CODE_RANDOM_LENGTH = 7;
export const HELMET_CODE_REGEX =
  /^HM-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export const ACTIVATION_PIN_ALPHABET = HELMET_CODE_ALPHABET;
export const ACTIVATION_PIN_LENGTH = 8;

export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 22 base62 symbols ≈ 130.9 bits of entropy (requirement: ≥ 128). */
export const PUBLIC_TOKEN_LENGTH = 22;
export const PUBLIC_TOKEN_REGEX = /^[0-9A-Za-z]{22}$/;

/**
 * Check symbol for helmet codes: weighted sum modulo 31 (prime), weights 1..8 over the
 * 7 payload symbols plus the check symbol, chosen so the full weighted sum is ≡ 0 (mod 31).
 * Because 31 is prime and the weights are distinct and non-zero, this detects every
 * single-symbol substitution and every adjacent transposition (including with the check
 * symbol). (Luhn mod N was rejected: its doubling step is not a bijection for odd N.)
 */
export function helmetCodeCheckSymbol(payload: string): string {
  const n = HELMET_CODE_ALPHABET.length; // 31
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const value = HELMET_CODE_ALPHABET.indexOf(payload.charAt(i));
    if (value < 0) throw new Error('Invalid symbol in payload');
    sum = (sum + (i + 1) * value) % n;
  }
  const checkWeight = payload.length + 1;
  // Solve checkWeight * c ≡ -sum (mod n) using the modular inverse of checkWeight.
  const inverse = modInverse(checkWeight, n);
  return HELMET_CODE_ALPHABET.charAt((((n - sum) % n) * inverse) % n);
}

function modInverse(a: number, m: number): number {
  for (let x = 1; x < m; x++) if ((a * x) % m === 1) return x;
  throw new Error('No modular inverse');
}

/** Formats 8 raw symbols as `HM-XXXX-XXXX`. */
export function formatHelmetCode(symbols: string): string {
  return `${HELMET_CODE_PREFIX}-${symbols.slice(0, 4)}-${symbols.slice(4, 8)}`;
}

/**
 * Normalises user input: trims, uppercases, removes spaces/dashes, and maps commonly
 * confused characters (O→0 is NOT valid, so O/0 are rejected rather than guessed).
 * Returns the canonical `HM-XXXX-XXXX` form or null when it cannot be parsed.
 */
export function normalizeHelmetCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '');
  const body = compact.startsWith(HELMET_CODE_PREFIX)
    ? compact.slice(HELMET_CODE_PREFIX.length)
    : compact;
  if (body.length !== HELMET_CODE_RANDOM_LENGTH + 1) return null;
  const formatted = formatHelmetCode(body);
  return HELMET_CODE_REGEX.test(formatted) ? formatted : null;
}

/** True when the code has the right shape AND a valid check symbol. */
export function isValidHelmetCode(code: string): boolean {
  if (!HELMET_CODE_REGEX.test(code)) return false;
  const symbols = code.slice(3).replace('-', '');
  const payload = symbols.slice(0, HELMET_CODE_RANDOM_LENGTH);
  return helmetCodeCheckSymbol(payload) === symbols.charAt(HELMET_CODE_RANDOM_LENGTH);
}

export function isValidPublicToken(token: string): boolean {
  return PUBLIC_TOKEN_REGEX.test(token);
}

/** `+919876543210` → `+91******3210` (display only). */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) return '*'.repeat(e164.length);
  return `${e164.slice(0, 3)}${'*'.repeat(e164.length - 7)}${e164.slice(-4)}`;
}

/** Offline account-recovery code: `RK-XXXX-XXXX-XXXX`, 12 symbols ≈ 59.4 bits. */
export const RECOVERY_CODE_PREFIX = 'RK';
export const RECOVERY_CODE_LENGTH = 12;
export const RECOVERY_CODE_REGEX =
  /^RK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

/** Canonical `RK-XXXX-XXXX-XXXX` from user input (case/spaces/dashes ignored), or null. */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '');
  const body = compact.startsWith(RECOVERY_CODE_PREFIX)
    ? compact.slice(RECOVERY_CODE_PREFIX.length)
    : compact;
  if (body.length !== RECOVERY_CODE_LENGTH) return null;
  const formatted = `${RECOVERY_CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  return RECOVERY_CODE_REGEX.test(formatted) ? formatted : null;
}

/** Ownership transfer code: `TR-XXXX-XXXX-XXXX`, 12 symbols ≈ 59.4 bits, single use, short TTL. */
export const TRANSFER_CODE_PREFIX = 'TR';
export const TRANSFER_CODE_LENGTH = 12;
export const TRANSFER_CODE_REGEX =
  /^TR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

/** Canonical `TR-XXXX-XXXX-XXXX` from user input (case/spaces/dashes ignored), or null. */
export function normalizeTransferCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '');
  const body = compact.startsWith(TRANSFER_CODE_PREFIX)
    ? compact.slice(TRANSFER_CODE_PREFIX.length)
    : compact;
  if (body.length !== TRANSFER_CODE_LENGTH) return null;
  const formatted = `${TRANSFER_CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  return TRANSFER_CODE_REGEX.test(formatted) ? formatted : null;
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const MAX_EMERGENCY_CONTACTS = 5;
