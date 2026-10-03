import { PASSWORD_MIN_LENGTH } from '@helmet/types';

export interface PasswordValue {
  password: string;
  confirm: string;
}

/** Client-side hints only; the API enforces the real policy (length + common-password check). */
export function passwordClientProblem(v: PasswordValue): string | null {
  if (v.password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (v.password !== v.confirm) return 'The passwords don’t match.';
  return null;
}
