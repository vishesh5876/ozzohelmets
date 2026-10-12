import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type AdminSafetyIdDetailDto, Permission } from '@helmet/types';
import {
  Badge,
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
  Textarea,
} from '@helmet/ui';
import { AuthImage } from '../../components/AuthImage';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { withAdminPassword } from '../../lib/admin-reauth';
import { api, apiRequest } from '../../lib/api';
import { formatDate, formatDateTime, formatNumber } from '../../lib/format';

/** Operator-facing Activation PIN state (the PIN itself is never shown). */
const PIN_STATE: Record<AdminSafetyIdDetailDto['pinState'], string> = {
  AVAILABLE: 'Available for printing',
  EXPORTED: 'Exported for printing',
  PURGED: 'Escrow purged',
  CONSUMED: 'Consumed',
};

type Action = 'deactivate' | 'reactivate' | 'link' | 'unlink' | 'integrity' | 'revoke' | null;

export function SafetyIdDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [action, setAction] = useState<Action>(null);
  const {
    data: s,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['safety-ids', id],
    queryFn: () => api.get<AdminSafetyIdDetailDto>(`/admin/safety-ids/${id}`),
  });
  const done = async (next: AdminSafetyIdDetailDto) => {
    qc.setQueryData(['safety-ids', id], next);
    await qc.invalidateQueries({ queryKey: ['safety-ids'] });
    setAction(null);
  };
  if (isLoading) return <LoadingState />;
  if (error || !s) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const inactive = s.status === 'DEACTIVATED' || s.status === 'REPLACED';

  return (
    <>
      <PageHeader
        title={s.safetyCode}
        description="Safety ID: the emergency QR identity, its owner, sharing and linked helmet."
        back={{ to: '/safety-ids', label: 'Safety IDs' }}
        actions={
          <RequirePermission permission={Permission.ANALYTICS_VIEW}>
            <Link
              to={`/analytics/safety-ids/${s.safetyCode}`}
              className="text-sm font-medium underline-offset-2 hover:underline"
            >
              QR activity
            </Link>
          </RequirePermission>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge tone={s.status === 'ACTIVE' ? 'solid' : 'soft'} data-testid="safety-status">
          {humanizeEnum(s.status)}
        </Badge>
        <Badge tone={s.emergencySharing ? 'solid' : 'muted'}>
          Emergency sharing {s.emergencySharing ? 'on' : 'off'}
        </Badge>
        {s.qrIntegrityStatus !== 'NORMAL' && (
          <Badge tone="danger">QR {humanizeEnum(s.qrIntegrityStatus).toLowerCase()}</Badge>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <Item label="Safety ID" value={<span className="font-mono">{s.safetyCode}</span>} />
                <Item
                  label="Activation PIN"
                  value={<span data-testid="pin-state">{PIN_STATE[s.pinState]}</span>}
                />
                <Item
                  label="Owner"
                  value={
                    s.owner ? (
                      <RequirePermission
                        permission={Permission.CUSTOMERS_READ}
                        fallback={<span className="font-mono">{s.owner.customerId}</span>}
                      >
                        <Link
                          to={`/customers/${s.owner.customerId}`}
                          className="font-mono hover:underline"
                        >
                          {s.owner.customerId}
                        </Link>
                      </RequirePermission>
                    ) : (
                      '—'
                    )
                  }
                />
                <Item
                  label="Batch"
                  value={
                    s.batch ? (
                      <Link
                        to={`/safety-id-batches/${s.batch.id}`}
                        className="font-mono hover:underline"
                      >
                        {s.batch.batchCode}
                      </Link>
                    ) : (
                      '—'
                    )
                  }
                />
                <Item label="Activated" value={s.activatedAt ? formatDate(s.activatedAt) : '—'} />
                <Item label="Created" value={formatDateTime(s.createdAt)} />
                <Item
                  label="Scans"
                  value={`${formatNumber(s.scanCount)}${s.lastScanAt ? ` · last ${formatDateTime(s.lastScanAt)}` : ''}`}
                />
                {s.batchLastExportedAt && (
                  <Item label="Last exported" value={formatDateTime(s.batchLastExportedAt)} />
                )}
                <div className="sm:col-span-2">
                  <dt className="text-body">Public QR URL</dt>
                  <dd className="mt-1 truncate rounded-md bg-canvas-soft px-3 py-2 font-mono text-xs">
                    {s.qrUrl}
                  </dd>
                </div>
                {s.qrIntegrityNote && (
                  <div className="sm:col-span-2">
                    <dt className="text-body">QR integrity note</dt>
                    <dd className="mt-1">{s.qrIntegrityNote}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          <Card data-testid="safety-linked-helmet">
            <CardHeader>
              <CardTitle>Linked helmet</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {s.linkedHelmetDetail ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Link
                      to={`/helmets/${s.linkedHelmetDetail.id}`}
                      className="font-mono font-medium hover:underline"
                    >
                      {s.linkedHelmetDetail.helmetCode}
                    </Link>
                    <p className="text-body">
                      {s.linkedHelmetDetail.brand} {s.linkedHelmetDetail.modelName}
                    </p>
                  </div>
                  <HelmetStatusBadge status={s.linkedHelmetDetail.status} />
                </div>
              ) : (
                <p className="text-body">Standalone — not linked to a helmet.</p>
              )}
              {s.linkHistory.length > 0 && (
                <ul className="divide-y divide-hairline rounded-md border border-hairline">
                  {s.linkHistory.map((l) => (
                    <li key={`${l.helmetCode}-${l.startedAt}`} className="px-3 py-2">
                      <span className="font-mono">{l.helmetCode}</span> · {humanizeEnum(l.reason)} ·{' '}
                      {formatDate(l.startedAt)} → {l.endedAt ? formatDate(l.endedAt) : 'current'}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Ownership history</CardTitle>
            </CardHeader>
            <CardContent>
              {s.ownershipHistory.length === 0 ? (
                <p className="text-sm text-body">Never activated.</p>
              ) : (
                <ul className="divide-y divide-hairline text-sm">
                  {s.ownershipHistory.map((o) => (
                    <li key={`${o.customerId}-${o.startedAt}`} className="py-2">
                      <span className="font-mono">{o.customerId}</span> · {humanizeEnum(o.status)} ·{' '}
                      {humanizeEnum(o.source)} · {formatDate(o.startedAt)} →{' '}
                      {o.endedAt ? formatDate(o.endedAt) : 'now'}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <RequirePermission permission={Permission.LABELS_READ}>
            <Card>
              <CardHeader>
                <CardTitle>QR code</CardTitle>
              </CardHeader>
              <CardContent className="flex justify-center">
                <AuthImage
                  path={`/admin/safety-ids/${id}/qr`}
                  alt={`QR code for ${s.safetyCode}`}
                  className="h-44 w-44"
                />
              </CardContent>
            </Card>
          </RequirePermission>
          <Card>
            <CardHeader>
              <CardTitle>Support actions</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <RequirePermission permission={Permission.SAFETY_IDS_MANAGE}>
                {inactive ? (
                  s.status === 'DEACTIVATED' && (
                    <Button variant="secondary" onClick={() => setAction('reactivate')}>
                      Reactivate
                    </Button>
                  )
                ) : (
                  <Button variant="secondary" onClick={() => setAction('deactivate')}>
                    Deactivate
                  </Button>
                )}
                {s.linkedHelmet ? (
                  <Button variant="secondary" onClick={() => setAction('unlink')}>
                    Unlink helmet
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setAction('link')}>
                    Link to a helmet
                  </Button>
                )}
              </RequirePermission>
              <RequirePermission permission={Permission.QR_INTEGRITY_MANAGE}>
                <Button variant="secondary" onClick={() => setAction('integrity')}>
                  QR integrity
                </Button>
              </RequirePermission>
              {s.owner && !s.linkedHelmet && (
                <RequirePermission permission={Permission.OWNERSHIP_REVOKE}>
                  <Button variant="secondary" onClick={() => setAction('revoke')}>
                    Revoke ownership
                  </Button>
                </RequirePermission>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      {action && (
        <ActionDialog action={action} safetyId={s} onClose={() => setAction(null)} onDone={done} />
      )}
    </>
  );
}

const TITLES: Record<Exclude<Action, null>, string> = {
  deactivate: 'Deactivate Safety ID',
  reactivate: 'Reactivate Safety ID',
  link: 'Link to a helmet',
  unlink: 'Unlink helmet',
  integrity: 'QR integrity',
  revoke: 'Revoke ownership',
};

function ActionDialog({
  action,
  safetyId: s,
  onClose,
  onDone,
}: {
  action: Exclude<Action, null>;
  safetyId: AdminSafetyIdDetailDto;
  onClose: () => void;
  onDone: (next: AdminSafetyIdDetailDto) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [helmetCode, setHelmetCode] = useState('');
  const [integrity, setIntegrity] = useState(s.qrIntegrityStatus);
  const needsPassword = action === 'deactivate' || action === 'revoke';
  const base = `/admin/safety-ids/${s.id}`;
  const run = useMutation({
    mutationFn: async (): Promise<AdminSafetyIdDetailDto> => {
      const withAuth = (path: string, body: unknown) =>
        withAdminPassword(password, (token) =>
          apiRequest<AdminSafetyIdDetailDto>(path, {
            method: 'POST',
            body,
            headers: { 'X-Recent-Auth': token },
          }),
        );
      switch (action) {
        case 'deactivate':
          return withAuth(`${base}/deactivate`, { reason });
        case 'revoke':
          return withAuth(`${base}/revoke-ownership`, { reason });
        case 'reactivate':
          return api.post(`${base}/reactivate`, { reason });
        case 'link':
          return api.post(`${base}/link`, { helmetCode, reason });
        case 'unlink':
          return api.post(`${base}/unlink`, { reason });
        case 'integrity':
          return api.post(`${base}/qr-integrity`, { status: integrity, note: reason });
      }
    },
    onSuccess: (next) => onDone(next),
  });
  return (
    <Dialog open onClose={onClose} title={TITLES[action]}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        {action === 'deactivate' && (
          <p className="text-sm text-body">
            The QR stops showing anyone&apos;s information at once. The owner and history are kept,
            and sharing is switched off.
          </p>
        )}
        {action === 'link' && (
          <Field
            label="Helmet ID"
            htmlFor="link-helmet"
            hint="The helmet must have no Safety ID and the same owner (or none)."
          >
            <Input
              id="link-helmet"
              className="font-mono uppercase"
              value={helmetCode}
              onChange={(e) => setHelmetCode(e.target.value)}
            />
          </Field>
        )}
        {action === 'integrity' && (
          <Field label="Status" htmlFor="integrity-status">
            <Select
              id="integrity-status"
              value={integrity}
              onChange={(e) => setIntegrity(e.target.value as typeof integrity)}
            >
              <option value="NORMAL">Normal</option>
              <option value="UNDER_REVIEW">Under review</option>
              <option value="COMPROMISED">Compromised</option>
            </Select>
          </Field>
        )}
        <Field label={action === 'integrity' ? 'Note' : 'Reason'} htmlFor="action-reason">
          <Textarea
            id="action-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {needsPassword && (
          <Field label="Your password" htmlFor="action-password">
            <Input
              id="action-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        <InlineError error={run.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={run.isPending}
            disabled={reason.trim().length < 3 || (needsPassword && !password)}
          >
            Confirm
          </Button>
        </div>
      </form>
    </Dialog>
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
