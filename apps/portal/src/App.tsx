import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

// Route-level code splitting keeps the emergency page's JavaScript minimal.
const EmergencyPage = lazy(() =>
  import('./pages/EmergencyPage').then((m) => ({ default: m.EmergencyPage })),
);
const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const ComingSoonPage = lazy(() =>
  import('./pages/ComingSoonPage').then((m) => ({ default: m.ComingSoonPage })),
);

export function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/e/:token" element={<EmergencyPage />} />
        <Route path="/" element={<HomePage />} />
        <Route
          path="/activate"
          element={
            <ComingSoonPage
              title="Helmet activation"
              description="Activation with your Helmet ID, PIN and mobile number opens soon."
            />
          }
        />
        <Route
          path="/login"
          element={
            <ComingSoonPage
              title="Sign in"
              description="Mobile number sign-in with a one-time code is coming soon."
            />
          }
        />
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
