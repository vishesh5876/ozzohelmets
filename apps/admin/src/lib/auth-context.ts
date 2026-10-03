import { createContext, useContext } from 'react';
import type { AdminProfile, Permission } from '@helmet/types';

export interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  admin: AdminProfile | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
