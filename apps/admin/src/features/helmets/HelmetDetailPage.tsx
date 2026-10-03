import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Copy, Download, ExternalLink } from 'lucide-react';
import {
  type EmergencyProfileStatus,
  type HelmetDetailDto,
  type HelmetStatus,
  Permission,
} from '@helmet/types';
import {
  Badge,
  type BadgeProps,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  HelmetStatusBadge,
  humanizeEnum,
  Input,
  Select,
} from '@helmet/ui';
import { AuthImage } from '../../components/AuthImage';
import { OwnershipCard, ReplacementCard, SupportActionsCard } from './HelmetLifecyclePanels';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api, apiBlob } from '../../lib/api';
import { downloadBlob, formatDateTime, formatNumber } from '../../lib/format';

/** Admins see only the profile status — never the medical content itself. */
const PROFILE_TONE: Record<EmergencyProfileStatus, NonNullable<BadgeProps['tone']>> = {
  NOT_CONFIGURED: 'outline',
  INCOMPLETE: 'soft',
  DISABLED: 'muted',
  ACTIVE: 'solid',
};

export function HelmetDetailPage() {
  const { id = '' } = useParams();
  const {
    data: helmet,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['helmets', id],
    queryFn: () => api.get<HelmetDetailDto>(`/admin/helmets/${id}`),
  });

  if (isLoading) return <LoadingState />;
  if (error || !helmet) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const download = async (kind: 'qr' | 'barcode', format: 'png' | 'svg') => {
    const { blob } = await apiBlob(`/admin/helmets/${id}/${kind}`, { query: { format } });
    downloadBlob(blob, `${helmet.helmetCode}-${kind}.${format}`);
  };

  return (
    <>
      <PageHeader
        back={{ to: '/helmets', label: 'Helmets' }}
        title={helmet.helmetCode}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <HelmetStatusBadge status={helmet.status} />
            <span>
              {helmet.helmetModel.name} · Serial{' '}
              <span className="font-mono text-sm">{helmet.serialNumber}</span>
            </span>
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Identity</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-5 text-sm sm:grid-cols-2">
                <Item
                  label="Helmet ID"
                  value={<span className="font-mono">{helmet.helmetCode}</span>}
                />
                <Item
                  label="Serial number"
                  value={<span className="font-mono">{helmet.serialNumber}</span>}
                />
                <Item
                  label="Model"
                  value={`${helmet.helmetModel.name} (${helmet.helmetModel.sku})`}
                />
                <Item
                  label="Batch"
                  value={
                    <Link
                      to={`/batches/${helmet.batch.id}`}
                      className="font-mono underline-offset-4 hover:underline"
                    >
                      {helmet.batch.batchCode}
                    </Link>
                  }
                />
                <Item
                  label="Activation PIN"
                  value={
                    helmet.activationPinUsed
                      ? 'Used'
                      : helmet.pinEscrowed
                        ? 'Unused · in escrow (exportable)'
                        : 'Unused · escrow purged'
                  }
                />
                <Item label="Activated" value={formatDateTime(helmet.activatedAt)} />
                <Item label="QR scans" value={formatNumber(helmet.scanCount)} />
                <Item
                  label="Owner"
                  value={
                    helmet.owner
                      ? `Customer ${helmet.owner.customerId}${helmet.owner.maskedMobile ? ` · ${helmet.owner.maskedMobile} (unverified)` : ''} · since ${formatDateTime(helmet.owner.since)}`
                      : 'No owner'
                  }
                />
                <Item
                  label="Emergency profile"
                  value={
                    helmet.owner ? (
                      <Badge tone={PROFILE_TONE[helmet.owner.emergencyProfileStatus]}>
                        {humanizeEnum(helmet.owner.emergencyProfileStatus)}
                      </Badge>
                    ) : (
                      '—'
                    )
                  }
                />
                <Item label="Created" value={formatDateTime(helmet.createdAt)} />
                <div className="sm:col-span-2">
                  <dt className="text-body">Public QR URL</dt>
                  <dd className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-canvas-soft px-3 py-2 font-mono text-xs">
                      {helmet.qrUrl}
                    </code>
                    <Button
                      variant="subtle"
                      size="icon"
                      aria-label="Copy URL"
                      onClick={() => void navigator.clipboard.writeText(helmet.qrUrl)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <a
                      href={helmet.qrUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open public page"
                      className="inline-flex h-10 w-10 items-center justify-center rounded-pill bg-canvas-soft hover:bg-surface-pressed"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <RequirePermission permission={Permission.OWNERSHIP_VIEW}>
            <OwnershipCard helmet={helmet} />
          </RequirePermission>
          <Card>
            <CardHeader>
              <CardTitle>Lifecycle history</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative flex flex-col gap-5 border-l border-hairline pl-5">
                {helmet.statusHistory.map((h) => (
                  <li key={h.id} className="relative">
                    <span
                      className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-ink"
                      aria-hidden
                    />
                    <p className="text-sm font-medium">
                      {h.fromStatus ? `${humanizeEnum(h.fromStatus)} → ` : ''}
                      {humanizeEnum(h.toStatus)}
                    </p>
                    <p className="text-xs text-body">
                      {formatDateTime(h.createdAt)} · {h.actorName ?? humanizeEnum(h.actorType)}
                      {h.reason ? ` · ${h.reason}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <RequirePermission permission={Permission.LABELS_READ}>
            <Card>
              <CardHeader>
                <CardTitle>QR code</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3">
                <AuthImage
                  path={`/admin/helmets/${id}/qr`}
                  alt={`QR code for ${helmet.helmetCode}`}
                  className="h-48 w-48"
                />
                <div className="flex gap-2">
                  <Button variant="subtle" size="sm" onClick={() => void download('qr', 'png')}>
                    <Download className="h-4 w-4" aria-hidden /> PNG
                  </Button>
                  <Button variant="subtle" size="sm" onClick={() => void download('qr', 'svg')}>
                    <Download className="h-4 w-4" aria-hidden /> SVG
                  </Button>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Barcode (Code128)</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3">
                <AuthImage
                  path={`/admin/helmets/${id}/barcode`}
                  alt={`Barcode for ${helmet.helmetCode}`}
                  className="h-20 w-full object-contain"
                />
                <div className="flex gap-2">
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => void download('barcode', 'png')}
                  >
                    <Download className="h-4 w-4" aria-hidden /> PNG
                  </Button>
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => void download('barcode', 'svg')}
                  >
                    <Download className="h-4 w-4" aria-hidden /> SVG
                  </Button>
                </div>
              </CardContent>
            </Card>
          </RequirePermission>
          <RequirePermission permission={Permission.HELMETS_UPDATE_STATUS}>
            <StatusChangeCard helmet={helmet} />
          </RequirePermission>
          <ReplacementCard helmet={helmet} />
          <SupportActionsCard helmet={helmet} />
        </div>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-body">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function StatusChangeCard({ helmet }: { helmet: HelmetDetailDto }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<HelmetStatus | ''>('');
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api.patch<HelmetDetailDto>(`/admin/helmets/${helmet.id}/status`, {
        status,
        reason: reason || undefined,
      }),
    onSuccess: async (updated) => {
      qc.setQueryData(['helmets', helmet.id], updated);
      await qc.invalidateQueries({ queryKey: ['helmets'], refetchType: 'none' });
      setStatus('');
      setReason('');
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change status</CardTitle>
      </CardHeader>
      <CardContent>
        {helmet.allowedTransitions.length === 0 ? (
          <p className="text-sm text-body">This helmet is in a final state.</p>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (status) mutation.mutate();
            }}
          >
            <Field
              label="New status"
              htmlFor="s-status"
              hint="Only transitions allowed by the helmet lifecycle are listed."
            >
              <Select
                id="s-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as HelmetStatus)}
              >
                <option value="">Select…</option>
                {helmet.allowedTransitions.map((s) => (
                  <option key={s} value={s}>
                    {humanizeEnum(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason" htmlFor="s-reason">
              <Input
                id="s-reason"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded in history and audit log"
              />
            </Field>
            <InlineError error={mutation.error} />
            <Button type="submit" disabled={!status} loading={mutation.isPending}>
              Update status
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
