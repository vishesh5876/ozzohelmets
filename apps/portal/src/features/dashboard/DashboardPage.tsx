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
import { AddMobileCard } from '../account/AddMobileCard';
import { HelmetCard } from '../helmets/HelmetCard';
import { SafetyIdCard } from '../safety-ids/SafetyIdsPage';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const COMPLETION_LABELS: Record<ProfileCompletionKey, string> = {
  IDENTITY: 'Name',
  BLOOD_GROUP: 'Blood group',
  MEDICAL_CONDITIONS: 'Medical conditions',
  ALLERGIES: 'Allergies',
  MEDICATIONS: 'Medications',
  EMERGENCY_CONTACT: 'Emergency contact',
  PRIVACY_REVIEW: 'Privacy review',
  SAFETY_ID_ENABLED: 'Sharing on a Safety ID',
};

export function DashboardPage() {
  const { customer } = useCustomerAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: keys.dashboard,
    queryFn: () => api.get<CustomerDashboardDto>('/customer/dashboard'),
  });

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} />;
  // Phase 9: protection is about Safety IDs (helmets are optional linked products).
  const owned = data.safetyIds.length > 0 || data.helmets.length > 0;
  const { total, active: sharingOn, needsSetup } = data.safetyIdSummary;

  return (
    <>
      <PageTitle
        title={customer?.name ? `Hi, ${customer.name.split(' ')[0]}` : 'Dashboard'}
        description="Your emergency protection, Safety IDs, helmets and account at a glance."
      />
      <div className="flex flex-col gap-6">
        {!owned && (
          <div className="rounded-xl bg-ink p-6 text-on-dark">
            <p className="text-display-sm font-semibold">Activate your first Safety ID</p>
            <p className="mt-1 text-mute">
              Scan the QR code of your Safety ID, or enter the Safety ID and its Activation PIN.
            </p>
            <Link
              to="/activate"
              className={buttonVariants({ variant: 'onDark', className: 'mt-4' })}
            >
              Activate Safety ID
            </Link>
          </div>
        )}

        {owned && (
          <section
            aria-labelledby="protection-h"
            data-testid="protection-status"
            className={cn(
              'rounded-xl border-2 p-5 sm:p-6',
              data.readiness.enabled && sharingOn > 0
                ? 'border-ink'
                : 'border-danger bg-danger-soft',
            )}
          >
            <p className="text-sm font-medium text-body">Emergency protection</p>
            {data.readiness.enabled && sharingOn > 0 ? (
              <>
                <h2 id="protection-h" className="mt-1 text-display-sm font-semibold">
                  Emergency information is active
                </h2>
                <p className="mt-1 text-body" data-testid="safety-id-summary">
                  {sharingOn} Safety ID{sharingOn === 1 ? '' : 's'} active
                  {needsSetup > 0
                    ? ` / ${needsSetup} need${needsSetup === 1 ? 's' : ''} setup`
                    : ''}{' '}
                  · {data.contactCount} emergency contact{data.contactCount === 1 ? '' : 's'}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    to="/app/profile"
                    className={buttonVariants({ variant: 'subtle', size: 'sm' })}
                  >
                    Update emergency profile
                  </Link>
                  <Link
                    to="/app/contacts"
                    className={buttonVariants({ variant: 'subtle', size: 'sm' })}
                  >
                    Emergency contacts
                  </Link>
                </div>
              </>
            ) : (
              <>
                <h2 id="protection-h" className="mt-1 text-display-sm font-semibold">
                  Emergency information is not active yet.
                </h2>
                <p className="mt-1 text-body">
                  {data.readiness.enabled
                    ? 'Your profile is ready but not shown on any Safety ID. Turn sharing on for the Safety ID you carry.'
                    : 'Anyone who scans your Safety ID sees only a basic notice until you finish setting up your emergency profile.'}
                </p>
                {total > 0 && (
                  <p className="mt-1 text-sm text-body" data-testid="safety-id-summary">
                    {sharingOn} Safety ID{sharingOn === 1 ? '' : 's'} active / {needsSetup} need
                    {needsSetup === 1 ? 's' : ''} setup
                  </p>
                )}
                <Link
                  to={data.readiness.enabled ? '/app/safety-ids' : '/app/onboarding'}
                  className={buttonVariants({ size: 'lg', className: 'mt-4' })}
                >
                  {data.readiness.enabled ? 'Choose a Safety ID' : 'Complete emergency setup'}
                </Link>
              </>
            )}
          </section>
        )}

        <AddMobileCard />

        {data.health.length > 0 && <HealthList warnings={data.health} />}

        {data.safetyIds.length > 0 && (
          <section aria-labelledby="safety-ids-h">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="safety-ids-h" className="text-display-sm font-semibold">
                My Safety IDs
              </h2>
              <Link to="/activate" className={buttonVariants({ variant: 'subtle', size: 'sm' })}>
                Add a Safety ID
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.safetyIds.map((x) => (
                <SafetyIdCard key={x.id} safetyId={x} />
              ))}
            </div>
          </section>
        )}

        {data.helmets.length > 0 && (
          <section aria-labelledby="helmets-h">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="helmets-h" className="text-display-sm font-semibold">
                My helmets
              </h2>
              <Link to="/app/helmets" className={buttonVariants({ variant: 'subtle', size: 'sm' })}>
                All helmets
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.helmets.map((h) => (
                <HelmetCard key={h.id} helmet={h} />
              ))}
            </div>
          </section>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <section className="rounded-xl border border-hairline p-5" aria-labelledby="profile-h">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="profile-h" className="font-bold">
                Emergency profile
              </h2>
              <span className="text-sm text-body">
                {data.readiness.enabled ? 'Shared on scan' : 'Not shared'}
              </span>
            </div>
            <p className="mt-2 font-bold tabular-nums" data-testid="completion">
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
          </section>

          <div className="flex flex-col gap-3">
            <section className="rounded-xl border border-hairline p-5" aria-labelledby="warranty-h">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="warranty-h" className="font-bold">
                  Warranty
                </h2>
                <Link
                  to="/app/warranty"
                  className="text-sm font-medium underline underline-offset-4"
                >
                  View
                </Link>
              </div>
              <p className="mt-2 text-sm text-body">
                <span className="font-bold text-ink tabular-nums">{data.warranty.active}</span>{' '}
                active
                {' · '}
                <span className="font-bold text-ink tabular-nums">
                  {data.warranty.notRegistered}
                </span>{' '}
                not registered
              </p>
            </section>
            <section className="rounded-xl border border-hairline p-5" aria-labelledby="security-h">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="security-h" className="font-bold">
                  Account security
                </h2>
                <Link
                  to="/app/account"
                  className="text-sm font-medium underline underline-offset-4"
                >
                  Manage
                </Link>
              </div>
              <dl className="mt-2 grid gap-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-body">Recovery Code</dt>
                  <dd className="font-medium">
                    {!data.security.recoveryCodeConfigured
                      ? 'Missing'
                      : data.security.recoveryCodeAcknowledged
                        ? 'Saved'
                        : 'Not confirmed as saved'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-body">Signed-in devices</dt>
                  <dd className="font-medium tabular-nums">{data.security.activeSessions}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-body">Password last changed</dt>
                  <dd className="font-medium">
                    {data.security.passwordChangedAt
                      ? dateFmt.format(new Date(data.security.passwordChangedAt))
                      : '—'}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        </div>

        <section aria-labelledby="activity-h">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="activity-h" className="font-bold">
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
            <p className="text-sm text-body">
              No account activity yet. Sign-ins and security changes will appear here.
            </p>
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
      <h2 id="health-h" className="mb-3 text-display-sm font-semibold">
        Safety check
      </h2>
      <ul className="flex flex-col gap-2" data-testid="health-warnings">
        {warnings.map((w, i) => {
          const s = SEVERITY[w.severity];
          const Icon = s.icon;
          return (
            <li
              key={`${w.code}-${w.safetyId ?? w.helmetId ?? i}`}
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
