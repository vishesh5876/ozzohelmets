import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@helmet/api-client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

/** Query keys for customer data; anything touching the emergency profile invalidates `emergency`. */
export const keys = {
  me: ['me'] as const,
  dashboard: ['dashboard'] as const,
  helmets: ['helmets'] as const,
  helmet: (id: string) => ['helmets', id] as const,
  profile: ['emergency', 'profile'] as const,
  contacts: ['emergency', 'contacts'] as const,
  visibility: ['emergency', 'visibility'] as const,
  readiness: ['emergency', 'readiness'] as const,
  preview: ['emergency', 'preview'] as const,
  sessions: ['sessions'] as const,
};
