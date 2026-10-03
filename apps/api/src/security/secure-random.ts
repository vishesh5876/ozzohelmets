import { randomBytes } from 'node:crypto';

/**
 * Uniformly random string over `alphabet` using the OS CSPRNG.
 * Uses rejection sampling so every symbol is equally likely (no modulo bias).
 */
export function secureRandomString(length: number, alphabet: string): string {
  const n = alphabet.length;
  if (n < 2 || n > 256) throw new RangeError('alphabet size must be between 2 and 256');
  if (!Number.isInteger(length) || length < 1)
    throw new RangeError('length must be a positive integer');
  // Largest multiple of n that fits in a byte; bytes >= limit are discarded.
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(Math.ceil((length - out.length) * 1.3) + 8);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const byte = buf[i] as number;
      if (byte < limit) out += alphabet.charAt(byte % n);
    }
  }
  return out;
}

/** Bits of entropy carried by a uniformly random string. */
export function entropyBits(length: number, alphabetSize: number): number {
  return length * Math.log2(alphabetSize);
}

/** 256-bit opaque token, base64url (refresh tokens, one-time secrets). */
export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
