import { type ReactNode, Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Boxes,
  ClipboardList,
  Factory,
  Flag,
  HardHat,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  Tags,
  Users,
  UserCog,
  X,
} from 'lucide-react';
import { Permission } from '@helmet/types';
import { cn, humanizeEnum } from '@helmet/ui';
import { useAuth } from '../lib/auth-context';
import { LoadingState } from './States';

interface NavItem {
  label: string;
  to?: string;
  icon: ReactNode;
  permission?: Permission;
  soon?: boolean;
  end?: boolean;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const ICON = 'h-4 w-4 shrink-0';

const NAV: NavSection[] = [
  {
    items: [
      {
        label: 'Dashboard',
        to: '/',
        icon: <LayoutDashboard className={ICON} />,
        permission: Permission.DASHBOARD_READ,
        end: true,
      },
    ],
  },
  {
    title: 'Products',
    items: [
      {
        label: 'Helmet models',
        to: '/models',
        icon: <Tags className={ICON} />,
        permission: Permission.MODELS_READ,
      },
    ],
  },
  {
    title: 'Manufacturing',
    items: [
      {
        label: 'Batches',
        to: '/batches',
        icon: <Factory className={ICON} />,
        permission: Permission.BATCHES_READ,
        end: true,
      },
      {
        label: 'Generate helmets',
        to: '/batches/new',
        icon: <Boxes className={ICON} />,
        permission: Permission.BATCHES_WRITE,
      },
    ],
  },
  {
    title: 'Helmets',
    items: [
      {
        label: 'All helmets',
        to: '/helmets',
        icon: <HardHat className={ICON} />,
        permission: Permission.HELMETS_READ,
        end: true,
      },
      {
        label: 'Activated',
        to: '/helmets/view/activated',
        icon: <ShieldCheck className={ICON} />,
        permission: Permission.HELMETS_READ,
      },
      {
        label: 'Unactivated',
        to: '/helmets/view/unactivated',
        icon: <HardHat className={ICON} />,
        permission: Permission.HELMETS_READ,
      },
      {
        label: 'Lost',
        to: '/helmets/view/lost',
        icon: <HardHat className={ICON} />,
        permission: Permission.HELMETS_READ,
      },
      {
        label: 'Stolen',
        to: '/helmets/view/stolen',
        icon: <HardHat className={ICON} />,
        permission: Permission.HELMETS_READ,
      },
      {
        label: 'Recalled',
        to: '/helmets/view/recalled',
        icon: <HardHat className={ICON} />,
        permission: Permission.HELMETS_READ,
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      {
        label: 'Warranties',
        to: '/warranties',
        icon: <ShieldCheck className={ICON} />,
        permission: Permission.WARRANTY_VIEW,
      },
      {
        label: 'Product reports',
        to: '/product-reports',
        icon: <Flag className={ICON} />,
        permission: Permission.PRODUCT_REPORT_VIEW,
      },
      {
        label: 'Customers',
        to: '/customers',
        icon: <Users className={ICON} />,
        permission: Permission.CUSTOMERS_READ,
      },
      {
        label: 'Privacy requests',
        to: '/privacy-requests',
        icon: <LifeBuoy className={ICON} />,
        permission: Permission.PRIVACY_REQUESTS_VIEW,
      },
      {
        label: 'Analytics',
        to: '/analytics',
        icon: <BarChart3 className={ICON} />,
        permission: Permission.ANALYTICS_VIEW,
      },
    ],
  },
  {
    title: 'Security',
    items: [
      {
        label: 'Admin users',
        to: '/admin-users',
        icon: <UserCog className={ICON} />,
        permission: Permission.ADMIN_USERS_MANAGE,
      },
      {
        label: 'Roles & permissions',
        to: '/roles',
        icon: <ShieldCheck className={ICON} />,
        permission: Permission.DASHBOARD_READ,
      },
      {
        label: 'Audit logs',
        to: '/audit-logs',
        icon: <ClipboardList className={ICON} />,
        permission: Permission.AUDIT_READ,
      },
      { label: 'Settings', icon: <Settings className={ICON} />, soon: true },
    ],
  },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can, admin, logout } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-ink text-on-dark">
          <Activity className="h-4 w-4" aria-hidden />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-bold">Helmet ID</p>
          <p className="text-xs text-body">Admin console</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Main">
        {NAV.map((section, i) => {
          const items = section.items.filter(
            (item) => item.soon || !item.permission || can(item.permission),
          );
          if (items.length === 0) return null;
          return (
            <div key={section.title ?? i} className="mt-4 first:mt-0">
              {section.title && (
                <p className="px-3 pb-1.5 text-xs font-medium text-mute">{section.title}</p>
              )}
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.label}>
                    {item.to && !item.soon ? (
                      <NavLink
                        to={item.to}
                        end={item.end}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-2.5 rounded-pill px-3 py-2 text-sm font-medium transition-colors',
                            isActive
                              ? 'bg-ink text-on-dark'
                              : 'text-hairline-mid hover:bg-canvas-soft hover:text-ink',
                          )
                        }
                      >
                        {item.icon}
                        {item.label}
                      </NavLink>
                    ) : (
                      <span
                        className="flex cursor-not-allowed items-center gap-2.5 px-3 py-2 text-sm text-mute"
                        aria-disabled
                      >
                        {item.icon}
                        {item.label}
                        <span className="ml-auto rounded-pill bg-canvas-soft px-2 py-0.5 text-[10px] font-medium text-body">
                          Soon
                        </span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      {admin && (
        <div className="border-t border-hairline p-4">
          <p className="truncate text-sm font-medium">{admin.name}</p>
          <p className="truncate text-xs text-body">
            {admin.email} · {humanizeEnum(admin.role)}
          </p>
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-3 inline-flex items-center gap-2 rounded-pill bg-canvas-soft px-3 py-1.5 text-sm font-medium hover:bg-surface-pressed"
          >
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
          <p className="mt-3 text-[11px] text-mute" data-testid="app-version">
            Version {import.meta.env.VITE_APP_VERSION ?? 'dev'} · Commit{' '}
            {(import.meta.env.VITE_GIT_SHA ?? 'local').slice(0, 7)}
          </p>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="min-h-dvh bg-canvas-softer">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-pill focus:bg-ink focus:px-4 focus:py-2 focus:text-on-dark"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-hairline bg-canvas lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            type="button"
            className="absolute inset-0 bg-ink/40"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 bg-canvas shadow-card">
            <button
              type="button"
              className="absolute right-3 top-4 rounded-pill p-2 hover:bg-canvas-soft"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
            >
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-hairline bg-canvas px-4 lg:hidden">
          <button
            type="button"
            className="rounded-pill p-2 hover:bg-canvas-soft"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <p className="text-sm font-bold">Helmet ID Admin</p>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
