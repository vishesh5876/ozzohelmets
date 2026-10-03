import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalises user input to E.164 (`+919876543210`). Numbers without a country code are read in
 * `defaultRegion`. Returns null for anything that is not a valid, dialable number.
 */
export function normalizePhone(input: string, defaultRegion: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length < 4 || trimmed.length > 32 || !/^[+\d\s().-]+$/.test(trimmed)) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
