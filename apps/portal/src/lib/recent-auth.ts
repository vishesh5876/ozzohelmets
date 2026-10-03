import type { RecentAuthResponse } from '@helmet/types';
import { api } from './api';

/**
 * Short-lived "password confirmed" token for sensitive actions. Kept in memory only (never in
 * storage); the API enforces expiry, session binding and revocation.
 */
let current: { token: string; expiresAt: number } | null = null;

export function recentAuthToken(): string | null {
  // 15 s margin so a token doesn't expire mid-request.
  return current && current.expiresAt - 15_000 > Date.now() ? current.token : null;
}

export async function confirmPassword(password: string): Promise<string> {
  const res = await api.post<RecentAuthResponse>('/customer/auth/reauthenticate', { password });
  current = { token: res.recentAuthToken, expiresAt: Date.now() + res.expiresIn * 1000 };
  return res.recentAuthToken;
}

export function clearRecentAuth(): void {
  current = null;
}

/** POST with the X-Recent-Auth header. */
export function postWithRecentAuth<T>(path: string, body?: unknown): Promise<T> {
  return api.request<T>(path, {
    method: 'POST',
    body,
    headers: { 'X-Recent-Auth': recentAuthToken() ?? '' },
  });
}
