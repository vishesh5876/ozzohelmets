import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRefresher } from '@helmet/api-client';
import type { CustomerLoginResponse, CustomerProfile } from '@helmet/types';
import { api } from './api';
import { CustomerAuthContext, type CustomerAuthState } from './auth-context';
import { API_BASE } from './config';
import { queryClient } from './query';
import { clearRecentAuth } from './recent-auth';

/**
 * Customer session: the access token lives only in memory; the refresh token is an httpOnly
 * cookie scoped to /api/v1/customer/auth. A silent refresh restores the session on load.
 */
export function CustomerAuthProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [status, setStatus] = useState<CustomerAuthState['status']>('loading');
  const tokenRef = useRef<string | null>(null);
  const customerIdRef = useRef<string | null>(null);
  const restoreRef = useRef<Promise<void>>(Promise.resolve());

  const apply = useCallback((session: CustomerLoginResponse | null) => {
    tokenRef.current = session?.accessToken ?? null;
    // A different (or no) customer never inherits a password confirmation.
    if (session?.customer.id !== customerIdRef.current) clearRecentAuth();
    customerIdRef.current = session?.customer.id ?? null;
    setCustomer(session?.customer ?? null);
    setStatus(session ? 'authenticated' : 'anonymous');
  }, []);

  const refresh = useMemo(
    () => createRefresher<CustomerLoginResponse>(`${API_BASE}/customer/auth/refresh`, apply),
    [apply],
  );

  useEffect(() => {
    api.configureAuth({ getToken: () => tokenRef.current, refresh });
    restoreRef.current = refresh().then(
      () => undefined,
      () => undefined,
    );
  }, [refresh]);

  const restored = useCallback(() => restoreRef.current, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/customer/auth/logout');
    } finally {
      apply(null);
      queryClient.clear();
    }
  }, [apply]);

  const value = useMemo<CustomerAuthState>(
    () => ({ status, customer, signIn: apply, signOut, setCustomer, restored }),
    [status, customer, apply, signOut, restored],
  );
  return <CustomerAuthContext.Provider value={value}>{children}</CustomerAuthContext.Provider>;
}
