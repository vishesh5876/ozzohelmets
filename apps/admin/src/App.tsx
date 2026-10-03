import { lazy, type ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Permission } from '@helmet/types';
import { AppShell } from './components/AppShell';
import { Forbidden } from './components/RequirePermission';
import { LoadingState } from './components/States';
import { LoginPage } from './features/auth/LoginPage';
import { useAuth } from './lib/auth-context';

const AdminUsersPage = lazy(() =>
  import('./features/admin-users/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage })),
);
const AuditLogsPage = lazy(() =>
  import('./features/audit/AuditLogsPage').then((m) => ({ default: m.AuditLogsPage })),
);
const BatchDetailPage = lazy(() =>
  import('./features/batches/BatchDetailPage').then((m) => ({ default: m.BatchDetailPage })),
);
const BatchesPage = lazy(() =>
  import('./features/batches/BatchesPage').then((m) => ({ default: m.BatchesPage })),
);
const CreateBatchPage = lazy(() =>
  import('./features/batches/CreateBatchPage').then((m) => ({ default: m.CreateBatchPage })),
);
const DashboardPage = lazy(() =>
  import('./features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const HelmetDetailPage = lazy(() =>
  import('./features/helmets/HelmetDetailPage').then((m) => ({ default: m.HelmetDetailPage })),
);
const HelmetsPage = lazy(() =>
  import('./features/helmets/HelmetsPage').then((m) => ({ default: m.HelmetsPage })),
);
const ModelsPage = lazy(() =>
  import('./features/models/ModelsPage').then((m) => ({ default: m.ModelsPage })),
);
const WarrantiesPage = lazy(() =>
  import('./features/warranty/WarrantiesPage').then((m) => ({ default: m.WarrantiesPage })),
);
const WarrantyDetailPage = lazy(() =>
  import('./features/warranty/WarrantyDetailPage').then((m) => ({
    default: m.WarrantyDetailPage,
  })),
);
const ProductReportsPage = lazy(() =>
  import('./features/product-reports/ProductReportsPage').then((m) => ({
    default: m.ProductReportsPage,
  })),
);
const RolesPage = lazy(() =>
  import('./features/roles/RolesPage').then((m) => ({ default: m.RolesPage })),
);

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingState label="Restoring session…" />;
  if (status === 'anonymous')
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function Guard({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <Forbidden />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Suspense fallback={<LoadingState />}>
              <AppShell />
            </Suspense>
          </RequireAuth>
        }
      >
        <Route
          index
          element={
            <Guard permission={Permission.DASHBOARD_READ}>
              <DashboardPage />
            </Guard>
          }
        />
        <Route
          path="models"
          element={
            <Guard permission={Permission.MODELS_READ}>
              <ModelsPage />
            </Guard>
          }
        />
        <Route
          path="batches"
          element={
            <Guard permission={Permission.BATCHES_READ}>
              <BatchesPage />
            </Guard>
          }
        />
        <Route
          path="batches/new"
          element={
            <Guard permission={Permission.BATCHES_WRITE}>
              <CreateBatchPage />
            </Guard>
          }
        />
        <Route
          path="batches/:id"
          element={
            <Guard permission={Permission.BATCHES_READ}>
              <BatchDetailPage />
            </Guard>
          }
        />
        <Route
          path="helmets"
          element={
            <Guard permission={Permission.HELMETS_READ}>
              <HelmetsPage />
            </Guard>
          }
        />
        <Route
          path="helmets/view/:view"
          element={
            <Guard permission={Permission.HELMETS_READ}>
              <HelmetsPage />
            </Guard>
          }
        />
        <Route
          path="helmets/:id"
          element={
            <Guard permission={Permission.HELMETS_READ}>
              <HelmetDetailPage />
            </Guard>
          }
        />
        <Route
          path="warranties"
          element={
            <Guard permission={Permission.WARRANTY_VIEW}>
              <WarrantiesPage />
            </Guard>
          }
        />
        <Route
          path="warranties/:id"
          element={
            <Guard permission={Permission.WARRANTY_VIEW}>
              <WarrantyDetailPage />
            </Guard>
          }
        />
        <Route
          path="product-reports"
          element={
            <Guard permission={Permission.PRODUCT_REPORT_VIEW}>
              <ProductReportsPage />
            </Guard>
          }
        />
        <Route
          path="audit-logs"
          element={
            <Guard permission={Permission.AUDIT_READ}>
              <AuditLogsPage />
            </Guard>
          }
        />
        <Route
          path="admin-users"
          element={
            <Guard permission={Permission.ADMIN_USERS_MANAGE}>
              <AdminUsersPage />
            </Guard>
          }
        />
        <Route path="roles" element={<RolesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
