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

/** Luhn mod N check symbol over the given alphabet. */
export function luhnModNCheckSymbol(
  payload: string,
  alphabet: string = HELMET_CODE_ALPHABET,
): string {
  const n = alphabet.length;
  let factor = 2;
  let sum = 0;
  for (let i = payload.length - 1; i >= 0; i--) {
    const codePoint = alphabet.indexOf(payload.charAt(i));
    if (codePoint < 0) throw new Error('Invalid symbol in payload');
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  const remainder = sum % n;
  return alphabet.charAt((n - remainder) % n);
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
  return luhnModNCheckSymbol(payload) === symbols.charAt(HELMET_CODE_RANDOM_LENGTH);
}

export function isValidPublicToken(token: string): boolean {
  return PUBLIC_TOKEN_REGEX.test(token);
}
