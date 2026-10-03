import { createContext, useContext } from 'react';
import type { CustomerLoginResponse, CustomerProfile } from '@helmet/types';

export interface CustomerAuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  customer: CustomerProfile | null;
  /** Called after a successful OTP verification. */
  signIn: (session: CustomerLoginResponse) => void;
  signOut: () => Promise<void>;
  setCustomer: (customer: CustomerProfile) => void;
}

export const CustomerAuthContext = createContext<CustomerAuthState | null>(null);

export function useCustomerAuth(): CustomerAuthState {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) throw new Error('useCustomerAuth must be used inside CustomerAuthProvider');
  return ctx;
}
