import type { ReactNode } from 'react';
import type { Permission } from '@helmet/types';
import { useAuth } from '../lib/auth-context';

/** UI-only gate. The API enforces the same permission; this just avoids showing dead ends. */
export function RequirePermission({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(permission) ? children : fallback}</>;
}

export function Forbidden() {
  return (
    <div className="rounded-xl border border-hairline bg-canvas px-6 py-14 text-center">
      <p className="font-bold">You don&apos;t have access to this page.</p>
      <p className="mt-1 text-sm text-body">Ask a super admin if you need this permission.</p>
    </div>
  );
}
