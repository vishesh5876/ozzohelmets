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
import { TRANSFERS_ENABLED } from '../../lib/config';

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
    enabled: !!helmet?.safetyId,
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
    .filter((a) => TRANSFERS_ENABLED || a !== 'TRANSFER')
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
        <h1 className="font-mono text-display-md font-semibold">{helmet.helmetCode}</h1>
        <HelmetStatusBadge status={helmet.status} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-4 md:col-span-2">
          <Section title="Safety ID" testId="protection-section">
            {helmet.safetyId ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-lg font-bold" data-testid="helmet-safety-id">
                    {helmet.safetyId.safetyCode}
                  </span>
                  <Badge tone={helmet.emergencyEnabled ? 'solid' : 'outline'}>
                    {helmet.emergencyEnabled ? 'Emergency sharing on' : 'Emergency sharing off'}
                  </Badge>
                  <Badge tone={profile.tone}>{profile.label}</Badge>
                </div>
                <p className="mt-3 text-sm text-body">
                  {helmet.emergencyEnabled
                    ? 'This helmet carries a Safety ID. Anyone who scans its QR code sees the emergency information you chose to share.'
                    : profileReady
                      ? 'Your emergency profile is ready, but this helmet’s Safety ID does not show it.'
                      : 'Emergency information is not active yet. Complete your emergency setup to show it on this helmet’s Safety ID.'}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    to={`/app/safety-ids/${helmet.safetyId.id}`}
                    className={buttonVariants({ variant: 'subtle' })}
                  >
                    View Safety ID
                  </Link>
                  {canEnable &&
                    (profileReady ? (
                      <Button loading={emergency.isPending} onClick={() => emergency.mutate(true)}>
                        Turn on emergency sharing
                      </Button>
                    ) : (
                      <Link
                        to={`/app/onboarding?safetyId=${encodeURIComponent(helmet.safetyId.id)}`}
                        className={buttonVariants()}
                      >
                        Complete emergency setup
                      </Link>
                    ))}
                  {canDisable && (
                    <Button
                      variant="secondary"
                      loading={emergency.isPending}
                      onClick={() => emergency.mutate(false)}
                    >
                      Turn off emergency sharing
                    </Button>
                  )}
                  {helmet.publicUrl && (
                    <a
                      href={helmet.publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={buttonVariants({ variant: 'subtle' })}
                    >
                      Open public page
                    </a>
                  )}
                </div>
                <InlineError error={emergency.error} />
              </>
            ) : (
              <p className="text-sm text-body">
                No Safety ID is linked to this helmet, so it has no emergency QR code. Contact
                support if your helmet came with a QR code.
              </p>
            )}
          </Section>

          <Section title="Identity">
            <dl className="grid gap-5 sm:grid-cols-2">
              <Item label="Model" value={`${helmet.model.brand} ${helmet.model.name}`} />
              <Item
                label="Helmet ID"
                value={<span className="font-mono">{helmet.helmetCode}</span>}
              />
              <Item
                label="Serial number"
                value={<span className="font-mono text-sm">{helmet.serialNumber}</span>}
              />
              <Item label="Status" value={<HelmetStatusBadge status={helmet.status} />} />
            </dl>
          </Section>

          <Card data-testid="warranty-section">
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-bold">Warranty</h2>
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

          <Section title="Ownership">
            <dl className="grid gap-5 sm:grid-cols-2">
              <Item
                label={helmet.acquiredVia === 'TRANSFER' ? 'Owned since' : 'Activated'}
                value={dateFmt.format(new Date(helmet.ownedSince))}
              />
              <Item
                label="How you got it"
                value={
                  helmet.acquiredVia === 'TRANSFER' ? 'Transferred to you' : 'Activated by you'
                }
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
                A Transfer Code is active until{' '}
                {dateTimeFmt.format(new Date(helmet.pendingTransfer.expiresAt))}.{' '}
                <Link to={`/app/helmets/${helmet.id}/transfer`} className="font-medium underline">
                  Manage transfer
                </Link>
              </p>
            )}
          </Section>

          <Section title="Lifecycle">
            {actions.length > 0 && (
              <div className="mb-5 flex flex-wrap gap-2" data-testid="helmet-actions">
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
            )}
            <ol
              className="relative flex flex-col gap-4 border-l border-hairline pl-5"
              data-testid="timeline"
              aria-label="Helmet history"
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
          </Section>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-3">
            <h2 className="self-start font-bold">QR code and activity</h2>
            {!helmet.safetyId ? (
              <p className="text-sm text-body">No Safety ID QR code on this helmet.</p>
            ) : qrUrl ? (
              <img
                src={qrUrl}
                alt={`Safety ID QR code for ${helmet.helmetCode}`}
                className="h-44 w-44"
              />
            ) : (
              <LoadingState label="" />
            )}
            {helmet.safetyId && (
              <>
                <p className="text-center text-xs text-body">
                  This is the Safety ID QR code that came with your helmet.
                </p>
                <ScanSummary helmetId={helmet.id} />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent>
        <h2 className="mb-4 font-bold">{title}</h2>
        {children}
      </CardContent>
    </Card>
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
