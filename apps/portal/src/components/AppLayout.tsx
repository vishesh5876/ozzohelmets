import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '@helmet/ui';
import { useCustomerAuth } from '../lib/auth-context';

const NAV = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/helmets', label: 'My helmets' },
  { to: '/app/profile', label: 'Emergency details' },
  { to: '/app/contacts', label: 'Contacts' },
  { to: '/app/privacy', label: 'Privacy' },
  { to: '/app/account', label: 'Account' },
];

export function AppLayout() {
  const { customer } = useCustomerAuth();
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-20 border-b border-hairline bg-canvas">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <NavLink to="/app" className="text-lg font-bold">
            Helmet ID
          </NavLink>
          <span className="truncate text-sm text-body">{customer?.name ?? 'My account'}</span>
        </div>
        <nav className="mx-auto max-w-5xl overflow-x-auto px-4 pb-3 sm:px-6" aria-label="Account">
          <ul className="flex gap-2">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    cn(
                      'block whitespace-nowrap rounded-pill px-4 py-2 text-sm font-medium',
                      isActive
                        ? 'bg-ink text-on-dark'
                        : 'bg-canvas-soft text-ink hover:bg-surface-pressed',
                    )
                  }
                >
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}

export function PageTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-display-md font-bold sm:text-display-lg">{title}</h1>
        {description && <p className="mt-1 text-body">{description}</p>}
      </div>
      {action}
    </div>
  );
}
