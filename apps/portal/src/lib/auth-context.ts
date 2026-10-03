import { createContext, useContext } from 'react';
import type { CustomerLoginResponse, CustomerProfile } from '@helmet/types';

export interface CustomerAuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  customer: CustomerProfile | null;
  /** Called after a successful sign-in, activation or password reset. */
  signIn: (session: CustomerLoginResponse) => void;
  signOut: () => Promise<void>;
  /**
   * Resolves once the on-load session restore has finished. Await it before any call that sets the
   * refresh cookie, so a late failed restore can't clear a cookie that was just issued.
   */
  restored: () => Promise<void>;
  setCustomer: (customer: CustomerProfile) => void;
}

export const CustomerAuthContext = createContext<CustomerAuthState | null>(null);

export function useCustomerAuth(): CustomerAuthState {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) throw new Error('useCustomerAuth must be used inside CustomerAuthProvider');
  return ctx;
}
