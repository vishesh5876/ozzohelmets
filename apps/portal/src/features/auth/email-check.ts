import { normalizeEmail } from '@helmet/types';

export const EMAIL_WARNING = 'Make sure this email is correct. You will use it to sign in.';

/** Client-side shape check (the server re-validates and canonicalises). */
export function emailClientProblem(email: string): string | null {
  return normalizeEmail(email) ? null : 'Enter a valid email address.';
}
