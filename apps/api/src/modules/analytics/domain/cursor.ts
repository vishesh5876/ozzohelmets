/** Opaque keyset cursor: base64url JSON `{ t, id }` (or `{ s, id }` for score ordering). */
export interface Cursor {
  t?: string;
  s?: number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): (Cursor & { t: string }) | null {
  const c = decodeAnyCursor(raw);
  return c && typeof c.t === 'string' && !Number.isNaN(Date.parse(c.t)) ? (c as Cursor & { t: string }) : null;
}

export function decodeAnyCursor(raw: string | undefined): Cursor | null {
  if (!raw || raw.length > 200) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    return typeof c.id === 'string' && /^[0-9a-f-]{36}$/.test(c.id) ? c : null;
  } catch {
    return null;
  }
}
