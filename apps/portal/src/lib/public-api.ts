import type { ApiResponse, PublicEmergencyDto } from '@helmet/types';
import { API_BASE } from './config';

export type EmergencyLookup =
  | { kind: 'ok'; data: PublicEmergencyDto }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'error' };

/**
 * Dependency-free fetch for the emergency page (no query library on this path).
 * Retries transient failures quickly: this page may be opened on a poor connection.
 */
export async function lookupEmergency(
  token: string,
  signal?: AbortSignal,
): Promise<EmergencyLookup> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/public/emergency/${encodeURIComponent(token)}`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (res.status === 404) return { kind: 'not-found' };
      if (res.status === 429) return { kind: 'rate-limited' };
      if (res.ok) {
        const body = (await res.json()) as ApiResponse<PublicEmergencyDto>;
        if (body.success) return { kind: 'ok', data: body.data };
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return { kind: 'error' };
}
