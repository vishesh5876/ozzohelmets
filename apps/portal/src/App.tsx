import { lazy, type ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { LoadingState } from './components/States';
import { useCustomerAuth } from './lib/auth-context';

const page = <T extends Record<string, unknown>>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((m) => ({ default: m[name] as React.ComponentType })));

const HomePage = page(() => import('./pages/HomePage'), 'HomePage');
const ComingSoonPage = lazy(() =>
  import('./pages/ComingSoonPage').then((m) => ({ default: m.ComingSoonPage })),
);
const LoginPage = page(() => import('./features/auth/LoginPage'), 'LoginPage');
const RecoverPage = page(() => import('./features/auth/RecoverPage'), 'RecoverPage');
const ActivatePage = page(() => import('./features/activation/ActivatePage'), 'ActivatePage');
const DashboardPage = page(() => import('./features/dashboard/DashboardPage'), 'DashboardPage');
const HelmetsPage = page(() => import('./features/helmets/HelmetsPage'), 'HelmetsPage');
const HelmetDetailPage = page(
  () => import('./features/helmets/HelmetDetailPage'),
  'HelmetDetailPage',
);
const OnboardingPage = page(() => import('./features/onboarding/OnboardingPage'), 'OnboardingPage');
const ProfilePage = page(() => import('./features/emergency/pages'), 'ProfilePage');
const ContactsPage = page(() => import('./features/emergency/pages'), 'ContactsPage');
const PrivacyPage = page(() => import('./features/emergency/pages'), 'PrivacyPage');
const AccountPage = page(() => import('./features/account/AccountPage'), 'AccountPage');

function RequireCustomer({ children }: { children: ReactNode }) {
  const { status } = useCustomerAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingState label="Restoring your session…" />;
  if (status === 'anonymous')
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  return <>{children}</>;
}

// /e/:token is served by the standalone emergency entry (emergency.html), not this app.
export function App() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/recover" element={<RecoverPage />} />
        <Route path="/activate" element={<ActivatePage />} />
        <Route
          path="/app"
          element={
            <RequireCustomer>
              <AppLayout />
            </RequireCustomer>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="helmets" element={<HelmetsPage />} />
          <Route path="helmets/:id" element={<HelmetDetailPage />} />
          <Route path="onboarding" element={<OnboardingPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="contacts" element={<ContactsPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="account" element={<AccountPage />} />
        </Route>
        <Route
          path="*"
          element={
            <ComingSoonPage
              title="Page not found"
              description="The page you are looking for does not exist."
            />
          }
        />
      </Routes>
    </Suspense>
  );
}
