import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  type AdminRecentAuthResponse,
  type AdminWarrantyDetailDto,
  Permission,
  WarrantyCorrectionReason,
  WarrantyVoidReason,
} from '@helmet/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  humanizeEnum,
  Input,
  Select,
} from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api, apiBlob, apiRequest } from '../../lib/api';
import { downloadBlob, formatDateTime } from '../../lib/format';
import { formatDay, STATUS_TONE } from './warranty-format';

export function WarrantyDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const {
    data: w,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['warranties', id],
    queryFn: () => api.get<AdminWarrantyDetailDto>(`/admin/warranties/${id}`),
  });
  const apply = (d: AdminWarrantyDetailDto) => {
    qc.setQueryData(['warranties', id], d);
    void qc.invalidateQueries({ queryKey: ['warranties'], refetchType: 'none' });
  };

  if (isLoading) return <LoadingState />;
  if (error || !w) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        back={{ to: '/warranties', label: 'Warranties' }}
        title={w.helmet.helmetCode}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[w.status]}>{w.status}</Badge>
            <span>
              {w.helmet.modelName} ·{' '}
              <Link to={`/helmets/${w.helmet.id}`} className="underline-offset-4 hover:underline">
                Helmet record
              </Link>
            </span>
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Coverage</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-5 text-sm sm:grid-cols-2">
                <Item label="Source" value={w.source ? humanizeEnum(w.source) : '—'} />
                <Item
                  label="Registered"
                  value={w.registeredAt ? formatDateTime(w.registeredAt) : '—'}
                />
                <Item label="Purchase date" value={formatDay(w.purchaseDate)} />
                <Item
                  label="Coverage"
                  value={`${formatDay(w.startDate)} – ${formatDay(w.endDate)}`}
                />
                <Item
                  label="Current owner"
                  value={<span className="font-mono">{w.ownerCustomerId ?? '—'}</span>}
                />
                <Item
                  label="Registered by"
                  value={<span className="font-mono">{w.registeredByCustomerId ?? '—'}</span>}
                />
                <Item
                  label="Purchase channel"
                  value={w.purchaseChannel ? humanizeEnum(w.purchaseChannel) : '—'}
                />
                <Item
                  label="Seller"
                  value={[w.sellerName, w.sellerCity].filter(Boolean).join(', ') || '—'}
                />
                <Item
                  label="Invoice number"
                  value={<span className="font-mono">{w.invoiceNumber ?? '—'}</span>}
                />
                <Item label="Customer notes" value={w.notes ?? '—'} />
                {w.voidReason && (
                  <Item
                    label="Void reason"
                    value={`${humanizeEnum(w.voidReason)} · ${formatDateTime(w.voidedAt!)}`}
                  />
                )}
                {w.replacementOf && (
                  <Item label="Replacement for" value={w.replacementOf.helmetCode} />
                )}
                {w.replacedBy && <Item label="Replaced by" value={w.replacedBy.helmetCode} />}
              </dl>
              <ProofRow w={w} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <ol
                className="relative flex flex-col gap-4 border-l border-hairline pl-5"
                data-testid="warranty-history"
              >
                {w.history.map((h) => (
                  <li key={h.id} className="relative">
                    <span
                      className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-ink"
                      aria-hidden
                    />
                    <p className="text-sm font-medium">
                      {humanizeEnum(h.event)}
                      {h.fromStatus && h.fromStatus !== h.toStatus
                        ? ` · ${h.fromStatus} → ${h.toStatus}`
                        : ''}
                    </p>
                    <p className="text-xs text-body">
                      {formatDateTime(h.createdAt)} · {h.actorName ?? humanizeEnum(h.actorType)}
                      {h.reasonCode ? ` · ${humanizeEnum(h.reasonCode)}` : ''}
                      {h.note ? ` · ${h.note}` : ''}
                    </p>
                    {h.changes && (
                      <p className="mt-0.5 font-mono text-xs text-body">
                        {JSON.stringify(h.changes)}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <RequirePermission permission={Permission.WARRANTY_MANAGE}>
            <CorrectCard w={w} onDone={apply} />
          </RequirePermission>
          <RequirePermission permission={Permission.WARRANTY_VOID}>
            <VoidRestoreCard w={w} onDone={apply} />
          </RequirePermission>
        </div>
      </div>
    </>
  );
}

function ProofRow({ w }: { w: AdminWarrantyDetailDto }) {
  const download = useMutation({
    mutationFn: async () => {
      const { blob } = await apiBlob(`/admin/warranties/${w.id}/proof`);
      downloadBlob(
        blob,
        `proof-${w.helmet.helmetCode}.${blob.type === 'application/pdf' ? 'pdf' : 'webp'}`,
      );
    },
  });
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-hairline pt-4 text-sm">
      <span>
        Proof of purchase:{' '}
        {w.hasProof ? `uploaded ${formatDateTime(w.proofUploadedAt!)}` : 'not uploaded'}
      </span>
      {w.hasProof && (
        <RequirePermission permission={Permission.WARRANTY_DOCUMENT_VIEW}>
          <Button
            size="sm"
            variant="subtle"
            loading={download.isPending}
            onClick={() => download.mutate()}
          >
            Download (audited)
          </Button>
        </RequirePermission>
      )}
      <InlineError error={download.error} />
    </div>
  );
}

function CorrectCard({
  w,
  onDone,
}: {
  w: AdminWarrantyDetailDto;
  onDone: (d: AdminWarrantyDetailDto) => void;
}) {
  const [purchaseDate, setPurchaseDate] = useState(w.purchaseDate ?? '');
  const [endDate, setEndDate] = useState('');
  const [invoice, setInvoice] = useState(w.invoiceNumber ?? '');
  const [reason, setReason] = useState<WarrantyCorrectionReason>('DATA_ENTRY_ERROR');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.patch<AdminWarrantyDetailDto>(`/admin/warranties/${w.id}`, {
        ...(purchaseDate && purchaseDate !== w.purchaseDate ? { purchaseDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(invoice !== (w.invoiceNumber ?? '') ? { invoiceNumber: invoice || null } : {}),
        reasonCode: reason,
        note: note || undefined,
      }),
    onSuccess: (d) => {
      setEndDate('');
      setNote('');
      onDone(d);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Correct warranty</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field
            label="Purchase date"
            htmlFor="wc-purchase"
            hint="Coverage is recomputed from the model policy."
          >
            <Input
              id="wc-purchase"
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
            />
          </Field>
          <Field label="Override end date (optional)" htmlFor="wc-end">
            <Input
              id="wc-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
          <Field label="Invoice number" htmlFor="wc-invoice">
            <Input
              id="wc-invoice"
              maxLength={64}
              value={invoice}
              onChange={(e) => setInvoice(e.target.value)}
            />
          </Field>
          <Field label="Reason" htmlFor="wc-reason">
            <Select
              id="wc-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as WarrantyCorrectionReason)}
            >
              {Object.values(WarrantyCorrectionReason).map((r) => (
                <option key={r} value={r}>
                  {humanizeEnum(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note (optional)" htmlFor="wc-note">
            <Input
              id="wc-note"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <InlineError error={save.error} />
          <Button type="submit" size="sm" loading={save.isPending}>
            Save correction
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function VoidRestoreCard({
  w,
  onDone,
}: {
  w: AdminWarrantyDetailDto;
  onDone: (d: AdminWarrantyDetailDto) => void;
}) {
  const [reason, setReason] = useState<WarrantyVoidReason>('INVALID_PURCHASE');
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const voidIt = useMutation({
    mutationFn: async () => {
      const { recentAuthToken } = await api.post<AdminRecentAuthResponse>(
        '/admin/auth/reauthenticate',
        {
          password,
        },
      );
      return apiRequest<AdminWarrantyDetailDto>(`/admin/warranties/${w.id}/void`, {
        method: 'POST',
        body: { reason, note: note || undefined },
        headers: { 'X-Recent-Auth': recentAuthToken },
      });
    },
    onSuccess: (d) => {
      setPassword('');
      setNote('');
      onDone(d);
    },
  });
  const restore = useMutation({
    mutationFn: () =>
      api.post<AdminWarrantyDetailDto>(`/admin/warranties/${w.id}/restore`, {
        note: note || undefined,
      }),
    onSuccess: onDone,
  });

  if (w.status === 'VOID') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Restore warranty</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-body">Undo a void made by mistake.</p>
          <Field label="Note (optional)" htmlFor="wr-note">
            <Input
              id="wr-note"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <InlineError error={restore.error} />
          <Button
            size="sm"
            variant="secondary"
            loading={restore.isPending}
            onClick={() => restore.mutate()}
          >
            Restore warranty
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (w.status !== 'ACTIVE' && w.status !== 'EXPIRED') return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Void warranty</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            voidIt.mutate();
          }}
        >
          <p className="text-sm text-body">
            An explicit decision; never automatic. The owner sees the warranty as void.
          </p>
          <Field label="Reason" htmlFor="wv-reason">
            <Select
              id="wv-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as WarrantyVoidReason)}
            >
              {Object.values(WarrantyVoidReason).map((r) => (
                <option key={r} value={r}>
                  {humanizeEnum(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note (optional)" htmlFor="wv-note">
            <Input
              id="wv-note"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <Field label="Your password" htmlFor="wv-password">
            <Input
              id="wv-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <InlineError error={voidIt.error} />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={voidIt.isPending}
            disabled={!password}
          >
            Void warranty
          </Button>
        </form>
      </CardContent>
    </Card>
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
