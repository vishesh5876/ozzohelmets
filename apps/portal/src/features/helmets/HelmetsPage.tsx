import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CustomerHelmetDto } from '@helmet/types';
import { buttonVariants } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { HelmetCard } from './HelmetCard';

export function HelmetsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: keys.helmets,
    queryFn: () => api.get<CustomerHelmetDto[]>('/customer/helmets'),
  });
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} />;
  return (
    <>
      <PageTitle title="My helmets" />
      {data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline p-8 text-center">
          <p className="font-bold">No helmets yet</p>
          <Link to="/activate" className={buttonVariants({ className: 'mt-4' })}>
            Activate helmet
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.map((h) => (
            <HelmetCard key={h.id} helmet={h} />
          ))}
        </div>
      )}
    </>
  );
}
