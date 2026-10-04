import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CustomerHelmetDto } from '@helmet/types';
import { buttonVariants, Card, CardContent } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { warrantyLine } from './warranty-labels';

/** Warranty status of every owned helmet, with a link to register or view each one. */
export function WarrantyOverviewPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: keys.helmets,
    queryFn: () => api.get<CustomerHelmetDto[]>('/customer/helmets'),
  });
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} />;
  return (
    <>
      <PageTitle title="Warranty" />
      {data.length === 0 ? (
        <p className="text-body">Activate a helmet to register its warranty.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {data.map((h) => (
            <li key={h.id}>
              <Card>
                <CardContent className="flex flex-col gap-2">
                  <p className="font-mono text-lg font-bold">{h.helmetCode}</p>
                  <p className="text-sm text-body">{warrantyLine(h.warranty)}</p>
                  <Link
                    to={`/app/helmets/${h.id}/warranty`}
                    className={buttonVariants({
                      variant: 'subtle',
                      size: 'sm',
                      className: 'self-start',
                    })}
                  >
                    {h.warranty.status === 'NOT_REGISTERED' ? 'Register warranty' : 'View warranty'}
                  </Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
