import { parseAccountIdentifier } from '@helmet/types';

export type CustomerQuery =
  | { kind: 'all' }
  | { kind: 'customerId'; code: string }
  | { kind: 'helmetId'; code: string }
  | { kind: 'email'; fragment: string }
  | { kind: 'text'; fragment: string }
  | { kind: 'tooShort' };

export const MIN_PARTIAL_QUERY = 3;

/**
 * Interprets an admin search box: exact Customer ID (`CU-…`, checksum-validated), exact Helmet ID
 * (`HM-…`), partial email (contains `@`) or partial name/email text (≥ 3 characters, so the
 * trigram index can serve it).
 */
export function parseCustomerQuery(raw: string | undefined): CustomerQuery {
  const q = (raw ?? '').trim();
  if (!q) return { kind: 'all' };
  if (!q.includes('@')) {
    const id = parseAccountIdentifier(q);
    if (id?.kind === 'customer') return { kind: 'customerId', code: id.code };
    if (id?.kind === 'helmet') return { kind: 'helmetId', code: id.code };
    // An ID-shaped query with a typo gets an exact (empty) answer, never a fuzzy match.
    if (/^CU[-\s]?[A-Z0-9]{4}/i.test(q)) return { kind: 'customerId', code: q.toUpperCase() };
    if (/^HM[-\s]?[A-Z0-9]{4}/i.test(q)) return { kind: 'helmetId', code: q.toUpperCase() };
  }
  const fragment = q.toLowerCase().slice(0, 254);
  if (fragment.length < MIN_PARTIAL_QUERY) return { kind: 'tooShort' };
  return q.includes('@') ? { kind: 'email', fragment } : { kind: 'text', fragment };
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function likeContains(fragment: string): string {
  return `%${fragment.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
