import { createHmac, timingSafeEqual } from 'node:crypto';
import { HELMET_CODE_ALPHABET, TRANSFER_CODE_LENGTH, TRANSFER_CODE_PREFIX } from '@helmet/types';
import { secureRandomString } from '../../security/secure-random';

/** `TR-XXXX-XXXX-XXXX`: 12 CSPRNG symbols from the unambiguous 31-symbol alphabet (≈ 59.4 bits). */
export function generateTransferCode(): string {
  const s = secureRandomString(TRANSFER_CODE_LENGTH, HELMET_CODE_ALPHABET);
  return `${TRANSFER_CODE_PREFIX}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/**
 * Keyed hash of a canonical transfer code. HMAC-SHA256 (not Argon2) is sufficient: codes carry
 * ~59 bits, live ≤ 30 min, are tied to one helmet and online guessing is lockout-limited; the
 * server-side key means a database leak alone doesn't allow offline guessing either.
 */
export function hashTransferCode(key: string, canonicalCode: string): string {
  return createHmac('sha256', key).update(`helmet-transfer:v1:${canonicalCode}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
