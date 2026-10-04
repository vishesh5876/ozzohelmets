import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Info,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import type { CustomerDashboardDto, HealthWarningDto, ProfileCompletionKey } from '@helmet/types';
import { buttonVariants, cn } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { keys } from '../../lib/query';
import { ReadinessCard } from '../emergency/ReadinessCard';
import { HelmetCard } from '../helmets/HelmetCard';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const COMPLETION_LABELS: Record<ProfileCompletionKey, string> = {
  IDENTITY: 'Name',
  BLOOD_GROUP: 'Blood group',
  MEDICAL_CONDITIONS: 'Medical conditions',
  ALLERGIES: 'Allergies',
  MEDICATIONS: 'Medications',
  EMERGENCY_CONTACT: 'Emergency contact',
  PRIVACY_REVIEW: 'Privacy review',
  HELMET_ENABLED: 'Sharing on a helmet',
};

export function DashboardPage() {
  const { customer } = useCustomerAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: keys.dashboard,
    queryFn: () => api.get<CustomerDashboardDto>('/customer/dashboard'),
  });

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} />;
  const owned = data.helmets.length > 0;

  return (
    <>
      <PageTitle
        title={customer?.name ? `Hi, ${customer.name.split(' ')[0]}` : 'Dashboard'}
        description="Your helmets, emergency profile and account at a glance."
      />
      <div className="flex flex-col gap-6">
        {!owned && (
          <div className="rounded-xl bg-ink p-6 text-on-dark">
            <p className="text-display-sm font-bold">Activate your first helmet</p>
            <p className="mt-1 text-mute">
              Scan the QR code inside your helmet, or enter its Helmet ID and activation PIN.
            </p>
            <Link
              to="/activate"
              className={buttonVariants({ variant: 'onDark', className: 'mt-4' })}
            >
              Activate helmet
            </Link>
          </div>
        )}

        {data.health.length > 0 && <HealthList warnings={data.health} />}

        {owned && !data.readiness.enabled && <ReadinessCard readiness={data.readiness} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <section className="rounded-xl border border-hairline p-5" aria-labelledby="profile-h">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="profile-h" className="font-bold">
                Emergency profile
              </h2>
              <span className="text-sm text-body">
                {data.readiness.enabled ? 'Shared on scan' : 'Not shared'}
              </span>
            </div>
            <p className="mt-2 text-display-sm font-bold tabular-nums" data-testid="completion">
              {data.completion.percent}% complete
            </p>
            <div
              className="mt-2 h-2 overflow-hidden rounded-pill bg-canvas-soft"
              role="progressbar"
              aria-label="Emergency profile completion"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={data.completion.percent}
            >
              <div className="h-full bg-ink" style={{ width: `${data.completion.percent}%` }} />
            </div>
            <ul className="mt-3 grid grid-cols-1 gap-1 text-sm min-[420px]:grid-cols-2">
              {data.completion.items.map((i) => (
                <li key={i.key} className="flex items-center gap-2">
                  {i.done ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-mute" aria-hidden />
                  )}
                  <span className={i.done ? '' : 'text-body'}>
                    {COMPLETION_LABELS[i.key]}
                    {!i.required && <span className="sr-only"> (optional)</span>}
                  </span>
                  <span className="sr-only">{i.done ? 'done' : 'not done'}</span>
                </li>
              ))}
            </ul>
            <Link
              to="/app/profile"
              className={buttonVariants({ variant: 'subtle', size: 'sm', className: 'mt-4' })}
            >
              Update emergency profile
            </Link>
          </section>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Helmets" value={data.helmets.length} to="/app/helmets" />
            <Stat label="Emergency contacts" value={data.contactCount} to="/app/contacts" />
            <Stat label="Warranties active" value={data.warranty.active} to="/app/warranty" />
            <Stat
              label="Signed-in devices"
              value={data.security.activeSessions}
              to="/app/account"
            />
          </div>
        </div>

        <section className="rounded-xl border border-hairline p-5" aria-labelledby="security-h">
          <h2 id="security-h" className="font-bold">
            Account security
          </h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-body">Recovery code</dt>
              <dd className="font-medium">
                {!data.security.recoveryCodeConfigured
                  ? 'Missing'
                  : data.security.recoveryCodeAcknowledged
                    ? 'Configured'
                    : 'Not confirmed as saved'}
              </dd>
            </div>
            <div>
              <dt className="text-body">Password last changed</dt>
              <dd className="font-medium">
                {data.security.passwordChangedAt
                  ? dateFmt.format(new Date(data.security.passwordChangedAt))
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-body">Account email</dt>
              <dd className="break-all font-medium">{data.security.email ?? 'Not set'}</dd>
            </div>
          </dl>
        </section>

        {owned && (
          <section aria-labelledby="helmets-h">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="helmets-h" className="text-display-sm font-bold">
                My helmets
              </h2>
              <Link to="/activate" className={buttonVariants({ variant: 'subtle', size: 'sm' })}>
                Add helmet
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.helmets.map((h) => (
                <HelmetCard key={h.id} helmet={h} />
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="actions-h">
          <h2 id="actions-h" className="mb-3 text-display-sm font-bold">
            Quick actions
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <QuickLink to="/activate" title="Add helmet" body="Scan the QR and enter its PIN." />
            <QuickLink
              to="/app/profile"
              title="Update emergency profile"
              body="Blood group, allergies, conditions."
            />
            <QuickLink
              to="/app/contacts"
              title="Add emergency contact"
              body="Who responders should call."
            />
            <QuickLink to="/app/privacy" title="Review privacy" body="Choose what a scan shows." />
            <QuickLink
              to="/app/warranty"
              title="View warranty"
              body="Register or check coverage."
            />
            <QuickLink
              to="/app/account"
              title="Manage account"
              body="Password, sessions, recovery code."
            />
          </div>
        </section>

        <section aria-labelledby="activity-h">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="activity-h" className="text-display-sm font-bold">
              Recent account activity
            </h2>
            <Link
              to="/app/account#activity"
              className="text-sm font-medium underline underline-offset-4"
            >
              All activity
            </Link>
          </div>
          {data.recentActivity.length === 0 ? (
            <p className="text-body">No account activity yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-hairline rounded-xl border border-hairline">
              {data.recentActivity.map((e) => (
                <li key={e.id} className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
                  <span className="font-medium">{e.label}</span>
                  <span className="text-body">
                    {dateFmt.format(new Date(e.createdAt))}
                    {e.device ? ` · ${e.device}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

const SEVERITY: Record<
  HealthWarningDto['severity'],
  { icon: LucideIcon; className: string; label: string }
> = {
  critical: { icon: ShieldAlert, className: 'border-danger bg-danger-soft', label: 'Important' },
  warning: { icon: AlertTriangle, className: 'border-ink bg-canvas', label: 'Needs attention' },
  info: { icon: Info, className: 'border-hairline bg-canvas-softer', label: 'Note' },
};

function HealthList({ warnings }: { warnings: HealthWarningDto[] }) {
  return (
    <section aria-labelledby="health-h">
      <h2 id="health-h" className="mb-3 text-display-sm font-bold">
        Safety check
      </h2>
      <ul className="flex flex-col gap-2" data-testid="health-warnings">
        {warnings.map((w, i) => {
          const s = SEVERITY[w.severity];
          const Icon = s.icon;
          return (
            <li
              key={`${w.code}-${w.helmetId ?? i}`}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-xl border-2 p-4',
                s.className,
              )}
              data-code={w.code}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden />
              <p className="min-w-0 flex-1">
                <span className="sr-only">{s.label}: </span>
                {w.message}
              </p>
              {w.action && (
                <Link
                  to={w.action.to}
                  className={buttonVariants({ variant: 'subtle', size: 'sm' })}
                >
                  {w.action.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Stat({ label, value, to }: { label: string; value: number; to: string }) {
  return (
    <Link to={to} className="rounded-xl border border-hairline p-4 hover:bg-canvas-softer">
      <p className="text-sm text-body">{label}</p>
      <p className="text-display-md font-bold tabular-nums">{value}</p>
    </Link>
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
