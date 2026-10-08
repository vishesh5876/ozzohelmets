import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CustomerHelmetDetailDto, CustomerScanSummaryDto } from '@helmet/types';
import { Badge, Button, buttonVariants, Card, CardContent, HelmetStatusBadge } from '@helmet/ui';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { ACTION_PAGES, TIMELINE_LABELS } from './lifecycle-labels';
import { warrantyLine } from '../warranty/warranty-labels';
import { PROFILE_LABEL } from './profile-label';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function HelmetDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const {
    data: helmet,
    isLoading,
    error,
  } = useQuery({
    queryKey: keys.helmet(id),
    queryFn: () => api.get<CustomerHelmetDetailDto>(`/customer/helmets/${id}`),
  });
  const qr = useQuery({
    queryKey: ['helmets', id, 'qr'],
    queryFn: () => api.blob(`/customer/helmets/${id}/qr`).then((r) => r.blob),
    enabled: !!helmet,
  });
  const qrUrl = useMemo(() => (qr.data ? URL.createObjectURL(qr.data) : null), [qr.data]);
  useEffect(() => () => (qrUrl ? URL.revokeObjectURL(qrUrl) : undefined), [qrUrl]);

  const emergency = useMutation({
    mutationFn: (on: boolean) =>
      api.post(`/customer/helmets/${id}/emergency/${on ? 'enable' : 'disable'}`),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.helmets }),
        qc.invalidateQueries({ queryKey: keys.dashboard }),
        qc.invalidateQueries({ queryKey: ['emergency'] }),
      ]);
    },
  });

  if (isLoading) return <LoadingState />;
  if (error || !helmet)
    return <ErrorState error={error} action={<Link to="/app/helmets">Back to my helmets</Link>} />;
  const profile = PROFILE_LABEL[helmet.emergencyProfileStatus];
  const actions = helmet.availableActions
    .map((a) => ACTION_PAGES[a])
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  const canEnable = helmet.availableActions.includes('ENABLE_EMERGENCY');
  const canDisable = helmet.availableActions.includes('DISABLE_EMERGENCY');
  const profileReady =
    helmet.emergencyProfileStatus === 'ACTIVE' || helmet.emergencyProfileStatus === 'DISABLED';

  return (
    <>
      <Link to="/app/helmets" className="text-sm font-medium text-body hover:text-ink">
        ← My helmets
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-display-md font-bold">{helmet.helmetCode}</h1>
        <HelmetStatusBadge status={helmet.status} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-4 md:col-span-2">
          <Card>
            <CardContent>
              <dl className="grid gap-5 sm:grid-cols-2">
                <Item label="Model" value={`${helmet.model.brand} ${helmet.model.name}`} />
                <Item
                  label="Serial number"
                  value={<span className="font-mono text-sm">{helmet.serialNumber}</span>}
                />
                <Item
                  label={helmet.acquiredVia === 'TRANSFER' ? 'Owned since' : 'Activated'}
                  value={dateFmt.format(new Date(helmet.ownedSince))}
                />
                <Item
                  label="Emergency information"
                  value={<Badge tone={profile.tone}>{profile.label}</Badge>}
                />
                {helmet.replacedBy && (
                  <Item
                    label="Replaced by"
                    value={<span className="font-mono">{helmet.replacedBy.helmetCode}</span>}
                  />
                )}
                {helmet.replaces && (
                  <Item
                    label="Replaces"
                    value={<span className="font-mono">{helmet.replaces.helmetCode}</span>}
                  />
                )}
              </dl>
              {helmet.pendingTransfer && (
                <p className="mt-5 rounded-md bg-canvas-soft px-4 py-3 text-sm">
                  A transfer code is active until{' '}
                  {dateTimeFmt.format(new Date(helmet.pendingTransfer.expiresAt))}.{' '}
                  <Link to={`/app/helmets/${helmet.id}/transfer`} className="font-medium underline">
                    Manage transfer
                  </Link>
                </p>
              )}
              <div className="mt-6 flex flex-wrap gap-2">
                {canEnable &&
                  (profileReady ? (
                    <Button loading={emergency.isPending} onClick={() => emergency.mutate(true)}>
                      Show emergency info on this helmet
                    </Button>
                  ) : (
                    <Link to="/app/onboarding" className={buttonVariants()}>
                      Set up emergency profile
                    </Link>
                  ))}
                {canDisable && (
                  <Button
                    variant="secondary"
                    loading={emergency.isPending}
                    onClick={() => emergency.mutate(false)}
                  >
                    Hide emergency info on this helmet
                  </Button>
                )}
                <a
                  href={helmet.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: 'subtle' })}
                >
                  Open public page
                </a>
              </div>
              <InlineError error={emergency.error} />
            </CardContent>
          </Card>

          <Card data-testid="warranty-section">
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-bold">Warranty</p>
                <p className="text-sm text-body">{warrantyLine(helmet.warranty)}</p>
              </div>
              <Link
                to={`/app/helmets/${helmet.id}/warranty`}
                className={buttonVariants({ variant: 'subtle', size: 'sm' })}
              >
                {helmet.warranty.status === 'NOT_REGISTERED'
                  ? 'Register warranty'
                  : 'View warranty'}
              </Link>
            </CardContent>
          </Card>

          {actions.length > 0 && (
            <Card>
              <CardContent className="flex flex-col gap-3">
                <p className="font-bold">Manage helmet</p>
                <div className="flex flex-wrap gap-2" data-testid="helmet-actions">
                  {actions.map((a) => (
                    <Link
                      key={a.slug}
                      to={`/app/helmets/${helmet.id}/${a.slug}`}
                      className={buttonVariants({ variant: 'subtle', size: 'sm' })}
                    >
                      {a.label}
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent>
              <p className="mb-4 font-bold">Timeline</p>
              <ol
                className="relative flex flex-col gap-4 border-l border-hairline pl-5"
                data-testid="timeline"
              >
                {[...helmet.timeline].reverse().map((e, i) => (
                  <li key={`${e.at}-${i}`} className="relative">
                    <span
                      className="absolute top-1.5 -left-[25px] h-2 w-2 rounded-full bg-ink"
                      aria-hidden
                    />
                    <p className="text-sm font-medium">
                      {TIMELINE_LABELS[e.type]}
                      {e.detail ? ` · ${e.detail}` : ''}
                    </p>
                    <p className="text-xs text-body">{dateTimeFmt.format(new Date(e.at))}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-3">
            <p className="self-start font-bold">Helmet QR code</p>
            {qrUrl ? (
              <img src={qrUrl} alt={`QR code for ${helmet.helmetCode}`} className="h-44 w-44" />
            ) : (
              <LoadingState label="" />
            )}
            <p className="text-center text-xs text-body">
              This is the code printed on your helmet.
            </p>
            <ScanSummary helmetId={helmet.id} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Neutral counts only: no visitor, device, location or risk details. */
function ScanSummary({ helmetId }: { helmetId: string }) {
  const { data } = useQuery({
    queryKey: ['helmets', helmetId, 'scan-summary'],
    queryFn: () => api.get<CustomerScanSummaryDto>(`/customer/helmets/${helmetId}/scan-summary`),
  });
  if (!data) return null;
  return (
    <div className="w-full border-t border-hairline pt-3 text-sm" data-testid="scan-summary">
      <p>{data.message}</p>
      {data.lastEmergencyScanAt && (
        <p className="mt-1 text-xs text-body">
          Emergency page last opened {dateTimeFmt.format(new Date(data.lastEmergencyScanAt))}
        </p>
      )}
    </div>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-body">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}
