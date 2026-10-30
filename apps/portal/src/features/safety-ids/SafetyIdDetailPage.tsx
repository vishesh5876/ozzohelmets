import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  CustomerSafetyIdDetailDto,
  CustomerScanSummaryDto,
  EmergencyReadinessDto,
  SafetyIdTransferStartResponse,
} from '@helmet/types';
import { Badge, Button, buttonVariants, Card, CardContent, HelmetStatusBadge } from '@helmet/ui';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { postWithRecentAuth } from '../../lib/recent-auth';
import { RecentAuthGate } from '../lifecycle/ConfirmPassword';
import { warrantyLine } from '../warranty/warranty-labels';
import { canShare, SAFETY_ID_STATUS, sharingLine } from './safety-id-labels';
import { HELMETS_ENABLED, TRANSFERS_ENABLED } from '../../lib/config';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SafetyIdDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const {
    data: s,
    isLoading,
    error,
  } = useQuery({
    queryKey: keys.safetyId(id),
    queryFn: () => api.get<CustomerSafetyIdDetailDto>(`/customer/safety-ids/${id}`),
  });
  const readiness = useQuery({
    queryKey: keys.readiness,
    queryFn: () => api.get<EmergencyReadinessDto>('/customer/emergency-profile/readiness'),
  });
  const qr = useQuery({
    queryKey: ['safety-ids', id, 'qr'],
    queryFn: () => api.blob(`/customer/safety-ids/${id}/qr`).then((r) => r.blob),
    enabled: !!s,
  });
  const qrUrl = useMemo(() => (qr.data ? URL.createObjectURL(qr.data) : null), [qr.data]);
  useEffect(() => () => (qrUrl ? URL.revokeObjectURL(qrUrl) : undefined), [qrUrl]);

  const sharing = useMutation({
    mutationFn: (on: boolean) =>
      api.post(`/customer/safety-ids/${id}/emergency/${on ? 'enable' : 'disable'}`),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.safetyIds }),
        qc.invalidateQueries({ queryKey: keys.helmets }),
        qc.invalidateQueries({ queryKey: keys.dashboard }),
        qc.invalidateQueries({ queryKey: ['emergency'] }),
      ]);
    },
  });

  if (isLoading) return <LoadingState />;
  if (error || !s)
    return (
      <ErrorState error={error} action={<Link to="/app/safety-ids">Back to my Safety IDs</Link>} />
    );
  const status = SAFETY_ID_STATUS[s.status];
  const profileReady = readiness.data?.canEnable ?? false;

  return (
    <>
      <Link to="/app/safety-ids" className="text-sm font-medium text-body hover:text-ink">
        ← My Safety IDs
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-display-md font-semibold">{s.safetyCode}</h1>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-4 md:col-span-2">
          <Card data-testid="safety-sharing">
            <CardContent>
              <h2 className="mb-2 font-bold">Emergency sharing</h2>
              <p className="font-medium">{sharingLine(s)}</p>
              <p className="mt-2 text-sm text-body">
                {s.emergencySharing
                  ? 'Anyone who scans this Safety ID sees the emergency information you chose to share.'
                  : canShare(s)
                    ? 'Your emergency profile is not shown on this Safety ID yet.'
                    : 'Sharing cannot be turned on while this Safety ID or its helmet is not in normal use.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {!s.emergencySharing &&
                  canShare(s) &&
                  (profileReady ? (
                    <Button loading={sharing.isPending} onClick={() => sharing.mutate(true)}>
                      Turn on emergency sharing
                    </Button>
                  ) : (
                    <Link
                      to={`/app/onboarding?safetyId=${encodeURIComponent(s.id)}`}
                      className={buttonVariants()}
                    >
                      Complete emergency setup
                    </Link>
                  ))}
                {s.emergencySharing && (
                  <Button
                    variant="secondary"
                    loading={sharing.isPending}
                    onClick={() => sharing.mutate(false)}
                  >
                    Turn off emergency sharing
                  </Button>
                )}
                <a
                  href={s.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: 'subtle' })}
                >
                  Open public page
                </a>
              </div>
              <InlineError error={sharing.error} />
            </CardContent>
          </Card>

          {HELMETS_ENABLED && (
            <Card data-testid="safety-linked">
              <CardContent>
                <h2 className="mb-2 font-bold">Linked product</h2>
                {s.linkedHelmet ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {s.linkedHelmet.brand} {s.linkedHelmet.modelName}
                      </p>
                      <p className="font-mono text-sm text-body">{s.linkedHelmet.helmetCode}</p>
                      {s.linkedWarranty && (
                        <p className="mt-1 text-sm text-body">{warrantyLine(s.linkedWarranty)}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <HelmetStatusBadge status={s.linkedHelmet.status} />
                      <Link
                        to={`/app/helmets/${s.linkedHelmet.id}`}
                        className={buttonVariants({ variant: 'subtle', size: 'sm' })}
                      >
                        View helmet
                      </Link>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-body">
                    This Safety ID is not linked to a helmet. It works on its own as a sticker or
                    card. There is no product warranty for a standalone Safety ID.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent>
              <h2 className="mb-4 font-bold">Details</h2>
              <dl className="grid gap-5 sm:grid-cols-2">
                <Item label="Safety ID" value={<span className="font-mono">{s.safetyCode}</span>} />
                <Item label="Status" value={status.label} />
                {s.activatedAt && (
                  <Item label="Activated" value={dateFmt.format(new Date(s.activatedAt))} />
                )}
                <Item label="Yours since" value={dateFmt.format(new Date(s.ownedSince))} />
              </dl>
            </CardContent>
          </Card>

          {/* A code issued before transfers were hidden can still be cancelled here. */}
          {((TRANSFERS_ENABLED && s.canTransfer) || s.pendingTransfer) && (
            <TransferCard safetyId={s} />
          )}
        </div>
        <Card>
          <CardContent className="flex flex-col items-center gap-3">
            <h2 className="self-start font-bold">QR code and activity</h2>
            {qrUrl ? (
              <img src={qrUrl} alt={`QR code for ${s.safetyCode}`} className="h-44 w-44" />
            ) : (
              <LoadingState label="" />
            )}
            <p className="text-center text-xs text-body">This is your Safety ID QR code.</p>
            <ScanSummary safetyId={s.id} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Standalone Safety IDs only (a linked one moves with its helmet's transfer). */
function TransferCard({ safetyId: s }: { safetyId: CustomerSafetyIdDetailDto }) {
  const qc = useQueryClient();
  const [issued, setIssued] = useState<SafetyIdTransferStartResponse | null>(null);
  const start = useMutation({
    mutationFn: () =>
      postWithRecentAuth<SafetyIdTransferStartResponse>(`/customer/safety-ids/${s.id}/transfer`),
    onSuccess: async (res) => {
      setIssued(res);
      await qc.invalidateQueries({ queryKey: keys.safetyId(s.id) });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.delete(`/customer/safety-ids/${s.id}/transfer`),
    onSuccess: async () => {
      setIssued(null);
      await qc.invalidateQueries({ queryKey: keys.safetyId(s.id) });
    },
  });
  return (
    <Card data-testid="safety-transfer">
      <CardContent className="flex flex-col gap-3">
        <h2 className="font-bold">Give this Safety ID to someone else</h2>
        <p className="text-sm text-body">
          The new owner needs the Safety ID and a one-time Transfer Code. Your emergency information
          stops showing as soon as they claim it.
        </p>
        {issued ? (
          <div className="rounded-md bg-canvas-soft p-4">
            <p className="text-sm text-body">Transfer Code — shown only once</p>
            <p className="font-mono text-xl font-bold" data-testid="safety-transfer-code">
              {issued.transferCode}
            </p>
            <p className="text-xs text-body">
              Valid until {dateTimeFmt.format(new Date(issued.expiresAt))}
            </p>
          </div>
        ) : s.pendingTransfer ? (
          <p className="text-sm">
            A Transfer Code is active until{' '}
            {dateTimeFmt.format(new Date(s.pendingTransfer.expiresAt))}.
          </p>
        ) : null}
        <RecentAuthGate intro="Transferring a Safety ID is sensitive. Confirm your password to continue.">
          <div className="flex flex-wrap gap-2">
            <Button loading={start.isPending} onClick={() => start.mutate()}>
              {s.pendingTransfer || issued ? 'Generate new code' : 'Generate Transfer Code'}
            </Button>
            {(s.pendingTransfer || issued) && (
              <Button
                variant="secondary"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel transfer
              </Button>
            )}
          </div>
        </RecentAuthGate>
        <InlineError error={start.error ?? cancel.error} />
      </CardContent>
    </Card>
  );
}

/** Neutral counts only: no visitor, device, location or risk details. */
function ScanSummary({ safetyId }: { safetyId: string }) {
  const { data } = useQuery({
    queryKey: ['safety-ids', safetyId, 'scan-summary'],
    queryFn: () => api.get<CustomerScanSummaryDto>(`/customer/safety-ids/${safetyId}/scan-summary`),
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
