import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CustomerHelmetDto, HelmetListGroup } from '@helmet/types';
import { buttonVariants } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { HelmetCard } from './HelmetCard';
import { GROUP_TITLES } from './lifecycle-labels';

const ORDER: HelmetListGroup[] = ['ACTIVE', 'NEEDS_ATTENTION', 'RETIRED'];

export function HelmetsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: keys.helmets,
    queryFn: () => api.get<CustomerHelmetDto[]>('/customer/helmets'),
  });
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} />;
  return (
    <>
      <PageTitle
        title="My helmets"
        action={
          <div className="flex gap-2">
            <Link to="/claim" className={buttonVariants({ variant: 'subtle', size: 'sm' })}>
              Claim a helmet
            </Link>
            <Link to="/activate" className={buttonVariants({ size: 'sm' })}>
              Add helmet
            </Link>
          </div>
        }
      />
      {data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline p-8 text-center">
          <p className="font-bold">No helmets yet</p>
          <Link to="/activate" className={buttonVariants({ className: 'mt-4' })}>
            Activate helmet
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {ORDER.map((group) => {
            const helmets = data.filter((h) => h.group === group);
            if (helmets.length === 0) return null;
            return (
              <section key={group} aria-labelledby={`group-${group}`}>
                <h2 id={`group-${group}`} className="mb-3 text-display-sm font-bold">
                  {GROUP_TITLES[group]}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {helmets.map((h) => (
                    <HelmetCard key={h.id} helmet={h} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
