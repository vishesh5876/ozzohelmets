import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AdminLoginResponse, AdminProfile } from '@helmet/types';
import { API_BASE, apiRequest, configureAuth } from './api';
import { AuthContext, type AuthState } from './auth-context';

/**
 * Access token lives only in memory (never localStorage). The refresh token is an httpOnly
 * cookie the browser sends to /api/v1/admin/auth/refresh; we refresh on load and on 401.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminProfile | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const tokenRef = useRef<string | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);

  const applySession = useCallback((session: AdminLoginResponse | null) => {
    tokenRef.current = session?.accessToken ?? null;
    setAdmin(session?.admin ?? null);
    setStatus(session ? 'authenticated' : 'anonymous');
  }, []);

  const refresh = useCallback((): Promise<string | null> => {
    // Single-flight: concurrent 401s share one refresh request (tokens rotate on every use).
    refreshing.current ??= fetch(`${API_BASE}/admin/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) {
          applySession(null);
          return null;
        }
        const body = (await res.json()) as { data: AdminLoginResponse };
        applySession(body.data);
        return body.data.accessToken;
      })
      .catch(() => {
        applySession(null);
        return null;
      })
      .finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  }, [applySession]);

  useEffect(() => {
    configureAuth({ getToken: () => tokenRef.current, refresh });
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await apiRequest<AdminLoginResponse>('/admin/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      applySession(session);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await apiRequest('/admin/auth/logout', { method: 'POST' });
    } finally {
      applySession(null);
    }
  }, [applySession]);

  const value = useMemo<AuthState>(
    () => ({ status, admin, login, logout, can: (p) => admin?.permissions.includes(p) ?? false }),
    [status, admin, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
