import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type AdminRecentAuthResponse,
  type HelmetDetailDto,
  type OwnershipPeriodDto,
  Permission,
  ReplacementReason,
  type TransferHistoryItemDto,
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
import { RequirePermission } from '../../components/RequirePermission';
import { InlineError } from '../../components/States';
import { api, apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

/** Confirms the admin password, then runs a sensitive support action with X-Recent-Auth. */
async function withAdminPassword<T>(password: string, run: (token: string) => Promise<T>) {
  const { recentAuthToken } = await api.post<AdminRecentAuthResponse>(
    '/admin/auth/reauthenticate',
    { password },
  );
  return run(recentAuthToken);
}

function useRefresh(helmetId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['helmets', helmetId] }),
      qc.invalidateQueries({ queryKey: ['helmets'], refetchType: 'none' }),
    ]);
}

/** Ownership periods + transfers (no medical data, no transfer codes). */
export function OwnershipCard({ helmet }: { helmet: HelmetDetailDto }) {
  const history = useQuery({
    queryKey: ['helmets', helmet.id, 'ownership'],
    queryFn: () =>
      api.page<OwnershipPeriodDto>(`/admin/helmets/${helmet.id}/ownership-history`, {
        pageSize: 20,
      }),
  });
  const transfers = useQuery({
    queryKey: ['helmets', helmet.id, 'transfers'],
    queryFn: () =>
      api.page<TransferHistoryItemDto>(`/admin/helmets/${helmet.id}/transfers`, { pageSize: 10 }),
  });
  const refresh = useRefresh(helmet.id);
  const cancel = useMutation({
    mutationFn: () => apiRequest(`/admin/helmets/${helmet.id}/transfer`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      await transfers.refetch();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ownership</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {helmet.pendingTransfer && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-canvas-soft px-4 py-3 text-sm">
            <span>
              Transfer pending · expires {formatDateTime(helmet.pendingTransfer.expiresAt)}
            </span>
            <RequirePermission permission={Permission.TRANSFER_CANCEL}>
              <Button
                size="sm"
                variant="secondary"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel transfer
              </Button>
            </RequirePermission>
          </div>
        )}
        <InlineError error={cancel.error} />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-body">
              <tr>
                <th className="py-2 pr-4 font-medium">Customer</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Via</th>
                <th className="py-2 pr-4 font-medium">From</th>
                <th className="py-2 font-medium">Until</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline" data-testid="ownership-history">
              {history.data?.items.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 pr-4">
                    <span className="font-mono text-xs">{p.customerId}</span>
                    {p.maskedMobile ? ` · ${p.maskedMobile}` : ''}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={p.status === 'ACTIVE' ? 'solid' : 'outline'}>
                      {humanizeEnum(p.status)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4">{humanizeEnum(p.acquiredVia)}</td>
                  <td className="py-2 pr-4">{formatDateTime(p.startedAt)}</td>
                  <td className="py-2">
                    {p.endedAt ? formatDateTime(p.endedAt) : '—'}
                    {p.endReason ? ` · ${humanizeEnum(p.endReason)}` : ''}
                    {p.endedByAdminName ? ` · ${p.endedByAdminName}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.data?.items.length === 0 && (
            <p className="py-3 text-sm text-body">This helmet has never been owned.</p>
          )}
        </div>
        {transfers.data && transfers.data.items.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Recent transfers</p>
            <ul className="flex flex-col gap-1 text-sm text-body">
              {transfers.data.items.map((t) => (
                <li key={t.id}>
                  {formatDateTime(t.createdAt)} · {humanizeEnum(t.status)}
                  {t.cancelReason ? ` (${humanizeEnum(t.cancelReason)})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ReplacementCard({ helmet }: { helmet: HelmetDetailDto }) {
  const refresh = useRefresh(helmet.id);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState<ReplacementReason>(ReplacementReason.DAMAGED);
  const [notes, setNotes] = useState('');
  const link = useMutation({
    mutationFn: () =>
      api.post('/admin/replacements', {
        originalHelmetId: helmet.id,
        replacementHelmetCode: code,
        reason,
        notes: notes || undefined,
      }),
    onSuccess: async () => {
      setCode('');
      setNotes('');
      await refresh();
    },
  });
  const { replacedBy, replaces } = helmet.replacement;
  const canLink =
    !replacedBy &&
    helmet.owner !== null &&
    ['ACTIVATED', 'ACTIVE', 'LOST', 'STOLEN', 'DAMAGED', 'RECALLED'].includes(helmet.status);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Replacement</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {replacedBy && (
          <p>
            Replaced by{' '}
            <Link to={`/helmets/${replacedBy.helmetId}`} className="font-mono underline">
              {replacedBy.helmetCode}
            </Link>{' '}
            · {humanizeEnum(replacedBy.reason)} · {formatDateTime(replacedBy.createdAt)}
            {replacedBy.createdByAdminName ? ` · ${replacedBy.createdByAdminName}` : ''}
          </p>
        )}
        {replaces && (
          <p>
            Replaces{' '}
            <Link to={`/helmets/${replaces.helmetId}`} className="font-mono underline">
              {replaces.helmetCode}
            </Link>{' '}
            · {humanizeEnum(replaces.reason)}
          </p>
        )}
        {!replacedBy && !replaces && <p className="text-body">No replacement links.</p>}
        {canLink && (
          <RequirePermission permission={Permission.REPLACEMENT_MANAGE}>
            <form
              className="flex flex-col gap-3 border-t border-hairline pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                link.mutate();
              }}
            >
              <p className="text-body">
                The new helmet must already be activated with its own PIN by the same customer. This
                helmet becomes REPLACED.
              </p>
              <Field label="Replacement Helmet ID" htmlFor="rep-code">
                <Input id="rep-code" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <Field label="Reason" htmlFor="rep-reason">
                <Select
                  id="rep-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value as ReplacementReason)}
                >
                  {Object.values(ReplacementReason).map((r) => (
                    <option key={r} value={r}>
                      {humanizeEnum(r)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Notes (optional)" htmlFor="rep-notes">
                <Input
                  id="rep-notes"
                  maxLength={500}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
              <InlineError error={link.error} />
              <Button type="submit" size="sm" loading={link.isPending} disabled={!code}>
                Link replacement
              </Button>
            </form>
          </RequirePermission>
        )}
      </CardContent>
    </Card>
  );
}

/** Support actions, each behind its own permission; destructive ones need the admin password. */
export function SupportActionsCard({ helmet }: { helmet: HelmetDetailDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Support actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {helmet.restoreTarget && (
          <RequirePermission permission={Permission.HELMET_LIFECYCLE_MANAGE}>
            <SupportForm
              helmet={helmet}
              title={`Restore to ${humanizeEnum(helmet.restoreTarget)}`}
              hint="Returns the helmet to its owner's safe state. Emergency information is never re-enabled automatically."
              button="Restore status"
              run={(reason) => api.post(`/admin/helmets/${helmet.id}/restore-status`, { reason })}
            />
          </RequirePermission>
        )}
        {helmet.status !== 'DEACTIVATED' && helmet.status !== 'REPLACED' && (
          <RequirePermission permission={Permission.HELMET_LIFECYCLE_MANAGE}>
            <SupportForm
              helmet={helmet}
              title="Force deactivation"
              hint="Sets DEACTIVATED. Public page shows the helmet is no longer active."
              button="Deactivate"
              sensitive
              run={(reason, token) =>
                apiRequest(`/admin/helmets/${helmet.id}/force-deactivate`, {
                  method: 'POST',
                  body: { reason },
                  headers: { 'X-Recent-Auth': token! },
                })
              }
            />
          </RequirePermission>
        )}
        {helmet.owner && (
          <RequirePermission permission={Permission.OWNERSHIP_REVOKE}>
            <RevokeForm helmet={helmet} />
          </RequirePermission>
        )}
      </CardContent>
    </Card>
  );
}

function SupportForm({
  helmet,
  title,
  hint,
  button,
  sensitive = false,
  run,
  extra,
}: {
  helmet: HelmetDetailDto;
  title: string;
  hint: string;
  button: string;
  sensitive?: boolean;
  run: (reason: string, token?: string) => Promise<unknown>;
  extra?: ReactNode;
}) {
  const refresh = useRefresh(helmet.id);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const action = useMutation({
    mutationFn: () =>
      sensitive ? withAdminPassword(password, (t) => run(reason, t)) : run(reason),
    onSuccess: async () => {
      setReason('');
      setPassword('');
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    action.mutate();
  };
  const id = title.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <form
      className="flex flex-col gap-3 border-b border-hairline pb-5 last:border-0"
      onSubmit={submit}
    >
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-body">{hint}</p>
      </div>
      {extra}
      <Field label="Reason" htmlFor={`${id}-reason`}>
        <Input
          id={`${id}-reason`}
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Recorded in history and audit log"
        />
      </Field>
      {sensitive && (
        <Field label="Your password" htmlFor={`${id}-password`}>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      )}
      <InlineError error={action.error} />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        loading={action.isPending}
        disabled={reason.trim().length < 3 || (sensitive && !password)}
      >
        {button}
      </Button>
    </form>
  );
}

function RevokeForm({ helmet }: { helmet: HelmetDetailDto }) {
  const [target, setTarget] = useState<'ACTIVATED' | 'DEACTIVATED'>('DEACTIVATED');
  const [revokeSessions, setRevokeSessions] = useState(false);
  return (
    <SupportForm
      helmet={helmet}
      title="Revoke ownership"
      hint="Exceptional. Ends the current ownership; the helmet is not made available to anyone else."
      button="Revoke ownership"
      sensitive
      extra={
        <>
          <Field label="Helmet becomes" htmlFor="revoke-target">
            <Select
              id="revoke-target"
              value={target}
              onChange={(e) => setTarget(e.target.value as 'ACTIVATED' | 'DEACTIVATED')}
            >
              <option value="DEACTIVATED">Deactivated</option>
              <option value="ACTIVATED">Activated (ownerless)</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={revokeSessions}
              onChange={(e) => setRevokeSessions(e.target.checked)}
            />
            Also sign the customer out everywhere (account security affected)
          </label>
        </>
      }
      run={(reason, token) =>
        apiRequest(`/admin/helmets/${helmet.id}/revoke-ownership`, {
          method: 'POST',
          body: { reason, targetStatus: target, revokeSessions },
          headers: { 'X-Recent-Auth': token! },
        })
      }
    />
  );
}
