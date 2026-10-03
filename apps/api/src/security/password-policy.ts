import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@helmet/types';

/**
 * Small embedded deny-list of the most common passwords (no external service, no cost).
 * Matching is case-insensitive.
 */
const COMMON = new Set(
  `password password1 password12 password123 passw0rd p@ssw0rd p@ssword 12345678 123456789 1234567890
  12341234 11111111 00000000 88888888 87654321 qwertyui qwerty123 qwertyuiop asdfghjk asdfasdf
  zxcvbnm1 1q2w3e4r 1qaz2wsx qazwsxedc iloveyou letmein1 welcome1 welcome123 admin123 administrator
  sunshine princess football baseball dragon123 monkey123 abc12345 abcd1234 aaaaaaaa changeme
  trustno1 superman batman123 starwars computer internet whatever freedom1 secret123 mustang1
  michael1 jennifer shadow12 master12 helmet12 helmet123 ozzohelmet emergency india123 bharat123`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Length-based policy (NIST SP 800-63B style): at least 8 characters, long passphrases allowed,
 * no forced composition rules. Rejects common passwords, single repeated characters, and the
 * helmet's own identifiers. Returns a user-facing reason, or null when acceptable.
 */
export function passwordProblem(
  password: string,
  context: { helmetCode?: string } = {},
): string | null {
  if (typeof password !== 'string' || password.trim().length === 0) return 'Enter a password.';
  if ([...password].length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if ([...password].length > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common. Choose something harder to guess.';
  if (/^(.)\1+$/.test(password)) return 'Avoid repeating a single character.';
  if (/^(0123456789|1234567890|abcdefgh|abcdefghij)/i.test(password) && password.length <= 12)
    return 'Avoid simple sequences.';
  if (context.helmetCode) {
    const compactCode = context.helmetCode.replace(/[^A-Z0-9]/gi, '').toLowerCase();
    if (lower.replace(/[^a-z0-9]/g, '').includes(compactCode))
      return 'Don’t use your Helmet ID in your password.';
  }
  return null;
}
