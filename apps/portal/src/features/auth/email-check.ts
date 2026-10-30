import { normalizeEmail } from '@helmet/types';

export const EMAIL_WARNING = 'Make sure this email is correct. You will use it to sign in.';

/** Client-side shape check (the server re-validates and canonicalises). */
export function emailClientProblem(email: string): string | null {
  return normalizeEmail(email) ? null : 'Enter a valid email address.';
}

/** Same address, ignoring case and surrounding spaces (the server's canonical form). */
export const sameEmail = (a: string, b: string) =>
  !!normalizeEmail(a) && normalizeEmail(a)?.normalized === normalizeEmail(b)?.normalized;
