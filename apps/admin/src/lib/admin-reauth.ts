import type { AdminRecentAuthResponse } from '@helmet/types';
import { api } from './api';

/** Confirms the admin password, then runs a sensitive action with the X-Recent-Auth token. */
export async function withAdminPassword<T>(
  password: string,
  run: (token: string) => Promise<T>,
): Promise<T> {
  const { recentAuthToken } = await api.post<AdminRecentAuthResponse>(
    '/admin/auth/reauthenticate',
    { password },
  );
  return run(recentAuthToken);
}
