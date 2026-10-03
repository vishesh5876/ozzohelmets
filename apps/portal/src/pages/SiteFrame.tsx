import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCustomerAuth } from '../lib/auth-context';

export function SiteFrame({ children }: { children: ReactNode }) {
  const { status } = useCustomerAuth();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-hairline">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-8">
          <Link to="/" className="text-lg font-bold">
            Helmet ID
          </Link>
          <nav className="flex items-center gap-2">
            <Link
              to={status === 'authenticated' ? '/app' : '/login'}
              className="rounded-pill px-4 py-2 text-sm font-medium hover:bg-canvas-soft"
            >
              {status === 'authenticated' ? 'My helmets' : 'Sign in'}
            </Link>
            <Link
              to="/activate"
              className="rounded-pill bg-ink px-4 py-2 text-sm font-medium text-on-dark hover:bg-black-elevated"
            >
              Activate
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="bg-ink text-on-dark">
        <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-mute sm:px-8">
          © {new Date().getFullYear()} Helmet ID. Emergency identity for riders.
        </div>
      </footer>
    </div>
  );
}
