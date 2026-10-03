import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CustomerDashboardDto } from '@helmet/types';
import { buttonVariants } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { keys } from '../../lib/query';
import { ReadinessCard } from '../emergency/ReadinessCard';
import { HelmetCard } from '../helmets/HelmetCard';

export function DashboardPage() {
  const { customer } = useCustomerAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: keys.dashboard,
    queryFn: () => api.get<CustomerDashboardDto>('/customer/dashboard'),
  });

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} />;

  return (
    <>
      <PageTitle
        title={customer?.name ? `Hi, ${customer.name.split(' ')[0]}` : 'Your helmets'}
        description="Your helmets and emergency profile at a glance."
      />
      <div className="flex flex-col gap-6">
        {data.helmets.length === 0 ? (
          <div className="rounded-xl bg-ink p-6 text-on-dark">
            <p className="text-display-sm font-bold">Activate your first helmet</p>
            <p className="mt-1 text-mute">
              Scan the QR code inside your helmet, or enter its Helmet ID.
            </p>
            <Link
              to="/activate"
              className={buttonVariants({ variant: 'onDark', className: 'mt-4' })}
            >
              Activate helmet
            </Link>
          </div>
        ) : (
          <ReadinessCard readiness={data.readiness} />
        )}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Helmets" value={data.helmets.length} />
          <Stat label="Active" value={data.helmets.filter((h) => h.status === 'ACTIVE').length} />
          <Stat label="Contacts" value={data.contactCount} />
        </div>
        {data.helmets.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-display-sm font-bold">My helmets</h2>
              <Link to="/activate" className={buttonVariants({ variant: 'subtle', size: 'sm' })}>
                Activate another
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.helmets.map((h) => (
                <HelmetCard key={h.id} helmet={h} />
              ))}
            </div>
          </section>
        )}
        <section className="grid gap-3 sm:grid-cols-3">
          <QuickLink
            to="/app/profile"
            title="Emergency details"
            body="Blood group, allergies, conditions."
          />
          <QuickLink
            to="/app/contacts"
            title="Emergency contacts"
            body="Who should be called first."
          />
          <QuickLink to="/app/privacy" title="Privacy" body="Choose what responders can see." />
        </section>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-hairline p-4">
      <p className="text-sm text-body">{label}</p>
      <p className="text-display-md font-bold tabular-nums">{value}</p>
    </div>
  );
}

function QuickLink({ to, title, body }: { to: string; title: string; body: string }) {
  return (
    <Link to={to} className="rounded-xl bg-canvas-soft p-5 hover:bg-surface-pressed">
      <p className="font-bold">{title}</p>
      <p className="text-sm text-body">{body}</p>
    </Link>
  );
}
