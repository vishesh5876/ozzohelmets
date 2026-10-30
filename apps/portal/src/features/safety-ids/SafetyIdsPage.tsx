import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CustomerSafetyIdDto } from '@helmet/types';
import { Badge, buttonVariants } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { SAFETY_ID_STATUS, sharingLine } from './safety-id-labels';
import { TRANSFERS_ENABLED } from '../../lib/config';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** "My Safety IDs": every emergency QR the customer owns, linked to a helmet or standalone. */
export function SafetyIdsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: keys.safetyIds,
    queryFn: () => api.get<CustomerSafetyIdDto[]>('/customer/safety-ids'),
  });
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} />;
  return (
    <>
      <PageTitle
        title="My Safety IDs"
        action={
          <div className="flex gap-2">
            {TRANSFERS_ENABLED && (
              <Link
                to="/claim?type=safety-id"
                className={buttonVariants({ variant: 'subtle', size: 'sm' })}
              >
                Claim a Safety ID
              </Link>
            )}
            <Link to="/activate" className={buttonVariants({ size: 'sm' })}>
              Add a Safety ID
            </Link>
          </div>
        }
      />
      <p className="-mt-2 mb-6 max-w-2xl text-sm text-body">
        A Safety ID is the QR code that shows your emergency information when someone scans it. It
        can come with a helmet or on its own as a sticker or card.
      </p>
      {data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline p-8 text-center">
          <p className="font-bold">No Safety IDs yet</p>
          <p className="mt-1 text-sm text-body">
            Scan the QR code of your Safety ID, or enter the Safety ID and its Activation PIN.
          </p>
          <Link to="/activate" className={buttonVariants({ className: 'mt-4' })}>
            Activate your Safety ID
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.map((s) => (
            <SafetyIdCard key={s.id} safetyId={s} />
          ))}
        </div>
      )}
    </>
  );
}

export function SafetyIdCard({ safetyId: s }: { safetyId: CustomerSafetyIdDto }) {
  const status = SAFETY_ID_STATUS[s.status];
  return (
    <Link
      to={`/app/safety-ids/${s.id}`}
      className="flex flex-col gap-3 rounded-xl border border-hairline p-5 transition-colors hover:border-ink"
      data-testid="safety-id-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-body">Safety ID</p>
          <p className="font-mono text-lg font-bold">{s.safetyCode}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="text-sm font-medium">{sharingLine(s)}</p>
      <p className="text-sm text-body">
        {s.linkedHelmet
          ? `Linked to ${s.linkedHelmet.brand} ${s.linkedHelmet.modelName} · ${s.linkedHelmet.helmetCode}`
          : 'Standalone (not linked to a helmet)'}
      </p>
      <div className="flex flex-wrap gap-2 text-xs text-body">
        {s.activatedAt && <span>Activated {dateFmt.format(new Date(s.activatedAt))}</span>}
        {s.pendingTransfer && <Badge tone="soft">Transfer pending</Badge>}
      </div>
    </Link>
  );
}
