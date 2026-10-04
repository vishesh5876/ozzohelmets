import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  type AdminCustomerDetailDto,
  type AdminCustomerStatusAction,
  type AdminSecurityEventDto,
  Permission,
  type RecoveryGrantIssuedDto,
} from '@helmet/types';
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
} from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { withAdminPassword } from '../../lib/admin-reauth';
import { api, apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { STATUS_TONE } from './customer-format';

/**
 * Operational support view of one customer. Never shows medical data, emergency-contact details,
 * passwords, recovery codes or hashes — the emergency profile appears only as a state.
 */
export function CustomerDetailPage() {
  const { customerId = '' } = useParams();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', 'detail', customerId],
    queryFn: () =>
      api.get<AdminCustomerDetailDto>(`/admin/customers/${encodeURIComponent(customerId)}`),
  });
  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const c = data;

  return (
    <>
      <PageHeader
        title={c.customerId}
        description={c.name ?? 'Customer account'}
        back={{ to: '/customers', label: 'Customers' }}
        actions={<Badge tone={STATUS_TONE[c.status]}>{humanizeEnum(c.status)}</Badge>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-2" data-testid="customer-summary">
                <Item
                  label="Customer ID"
                  value={<span className="font-mono">{c.customerId}</span>}
                />
                <Item
                  label="Account email"
                  value={<span className="break-all">{c.email ?? '—'}</span>}
                />
                <Item
                  label="Email verification"
                  value={c.emailVerified ? 'Verified' : 'Not verified (by design)'}
                />
                <Item label="Mobile (unverified)" value={c.mobile ?? '—'} />
                <Item label="Created" value={formatDateTime(c.createdAt)} />
                <Item
                  label="Last sign-in"
                  value={c.lastLoginAt ? formatDateTime(c.lastLoginAt) : 'Never'}
                />
                <Item label="Active sessions" value={String(c.activeSessions)} />
                <Item label="Warranties registered" value={String(c.warrantyCount)} />
                {c.statusChangedAt && (
                  <Item
                    label="Status changed"
                    value={`${formatDateTime(c.statusChangedAt)}${c.statusReason ? ` — ${c.statusReason}` : ''}`}
                  />
                )}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Helmets</CardTitle>
            </CardHeader>
            <CardContent>
              {c.helmets.length === 0 ? (
                <p className="text-sm text-body">No helmets currently owned.</p>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Helmet ID</Th>
                      <Th>Model</Th>
                      <Th>Status</Th>
                      <Th>Emergency sharing</Th>
                      <Th>Warranty</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {c.helmets.map((h) => (
                      <Tr key={h.id}>
                        <Td className="font-mono text-xs">
                          <Link to={`/helmets/${h.id}`} className="hover:underline">
                            {h.helmetCode}
                          </Link>
                        </Td>
                        <Td>{h.modelName}</Td>
                        <Td>
                          <HelmetStatusBadge status={h.status} />
                        </Td>
                        <Td>{h.emergencySharing ? 'On' : 'Off'}</Td>
                        <Td>{humanizeEnum(h.warrantyStatus)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {c.ownershipHistory.length > 0 && (
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Ownership history ({c.ownershipHistory.length})
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {c.ownershipHistory.map((o) => (
                      <li key={`${o.helmetId}-${o.from}`}>
                        <span className="font-mono">{o.helmetCode}</span> ·{' '}
                        {humanizeEnum(o.acquiredVia)} · {formatDateTime(o.from)}
                        {o.until ? ` → ${formatDateTime(o.until)}` : ' → now'} ·{' '}
                        {humanizeEnum(o.status)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Emergency profile</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <p data-testid="emergency-state">
                {c.emergency.configured ? 'Configured' : 'Not configured'} ·{' '}
                {c.emergency.enabled ? 'Enabled' : 'Disabled'} · {c.emergency.contactCount}{' '}
                emergency contact{c.emergency.contactCount === 1 ? '' : 's'}
              </p>
              <p className="mt-2 text-body">
                Medical details and contacts are encrypted and visible only to the customer and, as
                they chose, on the public QR page. Support never sees them.
              </p>
            </CardContent>
          </Card>

          <RequirePermission permission={Permission.SECURITY_EVENTS_VIEW}>
            <SecurityEventsCard customerId={c.customerId} />
          </RequirePermission>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Recovery & security</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm" data-testid="recovery-state">
                <Item
                  label="Recovery code"
                  value={
                    c.recovery.recoveryCodeConfigured
                      ? c.recovery.recoveryCodeAcknowledged
                        ? 'Configured'
                        : 'Configured (not confirmed as saved)'
                      : 'Missing'
                  }
                />
                <Item
                  label="Password changed"
                  value={
                    c.security.passwordChangedAt
                      ? formatDateTime(c.security.passwordChangedAt)
                      : '—'
                  }
                />
                <Item label="Sign-in blocks (30 days)" value={String(c.security.loginBlocks30d)} />
                <Item
                  label="Open recovery grant"
                  value={
                    c.recovery.openGrantExpiresAt
                      ? `Expires ${formatDateTime(c.recovery.openGrantExpiresAt)}`
                      : 'None'
                  }
                />
                {c.recovery.lastGrantUsedAt && (
                  <Item
                    label="Last grant used"
                    value={formatDateTime(c.recovery.lastGrantUsedAt)}
                  />
                )}
              </dl>
              <p className="mt-3 text-xs text-body">
                Support can never see or retrieve a recovery code.
              </p>
            </CardContent>
          </Card>

          {c.deletionRequest && (
            <Card>
              <CardHeader>
                <CardTitle>Deletion request</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {humanizeEnum(c.deletionRequest.status)} · requested{' '}
                {formatDateTime(c.deletionRequest.requestedAt)}{' '}
                <Link to="/privacy-requests" className="underline">
                  Privacy requests
                </Link>
              </CardContent>
            </Card>
          )}

          <RequirePermission permission={Permission.CUSTOMERS_MANAGE}>
            <StatusActions customer={c} />
          </RequirePermission>
          <RequirePermission permission={Permission.CUSTOMER_RECOVERY_GRANT}>
            <RecoveryGrantCard customer={c} />
          </RequirePermission>
          <RequirePermission permission={Permission.CUSTOMERS_DELETE}>
            <MarkDeletedCard customer={c} />
          </RequirePermission>
        </div>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-body">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function useRefresh(_customerId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['customers'] });
}

const ACTIONS: Record<AdminCustomerStatusAction, { label: string; help: string }> = {
  SUSPEND: { label: 'Suspend account', help: 'Blocks sign-in and ends all sessions.' },
  LOCK: { label: 'Lock account (security)', help: 'For suspected takeover. Ends all sessions.' },
  RESTORE: { label: 'Restore account', help: 'Allows sign-in again.' },
};

function StatusActions({ customer }: { customer: AdminCustomerDetailDto }) {
  const refresh = useRefresh(customer.customerId);
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: (action: AdminCustomerStatusAction) =>
      api.post(`/admin/customers/${customer.customerId}/status`, { action, reason }),
    onSuccess: () => {
      setReason('');
      void refresh();
    },
  });
  const logout = useMutation({
    mutationFn: () => api.post(`/admin/customers/${customer.customerId}/logout-all`, { reason }),
    onSuccess: () => {
      setReason('');
      void refresh();
    },
  });
  if (customer.status === 'DELETED') return null;
  const actions: AdminCustomerStatusAction[] =
    customer.status === 'ACTIVE'
      ? ['SUSPEND', 'LOCK']
      : customer.status === 'SUSPENDED'
        ? ['RESTORE', 'LOCK']
        : ['RESTORE', 'SUSPEND'];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Support actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-body">
          Suspension does not hide the rider’s emergency information on their helmets.
        </p>
        <Field label="Reason (internal, required)" htmlFor="status-reason">
          <Input
            id="status-reason"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {actions.map((a) => (
          <Button
            key={a}
            variant={a === 'RESTORE' ? 'primary' : 'secondary'}
            disabled={reason.trim().length < 5}
            loading={change.isPending && change.variables === a}
            onClick={() => change.mutate(a)}
            title={ACTIONS[a].help}
          >
            {ACTIONS[a].label}
          </Button>
        ))}
        <Button
          variant="subtle"
          disabled={reason.trim().length < 5}
          loading={logout.isPending}
          onClick={() => logout.mutate()}
        >
          Sign out all sessions
        </Button>
        <InlineError error={change.error ?? logout.error} />
        {logout.isSuccess && <p className="text-sm">All sessions ended.</p>}
      </CardContent>
    </Card>
  );
}

/** Last resort for a customer who lost password AND recovery code. SUPER_ADMIN only. */
function RecoveryGrantCard({ customer }: { customer: AdminCustomerDetailDto }) {
  const refresh = useRefresh(customer.customerId);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [issued, setIssued] = useState<RecoveryGrantIssuedDto | null>(null);
  const issue = useMutation({
    mutationFn: () =>
      withAdminPassword(password, (token) =>
        apiRequest<RecoveryGrantIssuedDto>(
          `/admin/customers/${customer.customerId}/recovery-grants`,
          {
            method: 'POST',
            body: { reason, confirmCustomerId: confirm },
            headers: { 'X-Recent-Auth': token },
          },
        ),
      ),
    onSuccess: (r) => {
      setIssued(r);
      setReason('');
      setConfirm('');
      setPassword('');
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      apiRequest(`/admin/customers/${customer.customerId}/recovery-grants`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
  });
  if (customer.status !== 'ACTIVE' && !issued) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    issue.mutate();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account recovery grant</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {issued ? (
          <div className="flex flex-col gap-3" data-testid="grant-issued">
            <p className="text-sm">
              Give this one-time credential to the verified customer by phone or in person. It is
              shown only now, works once and expires {formatDateTime(issued.expiresAt)}.
            </p>
            <p
              className="rounded-md border-2 border-dashed border-ink px-3 py-4 text-center font-mono text-lg font-bold"
              data-testid="grant-credential"
            >
              {issued.credential}
            </p>
            <p className="text-xs text-body">
              The customer enters their Customer ID and this credential on “Forgot password”.
            </p>
            <Button variant="subtle" onClick={() => setIssued(null)}>
              Done — I’ve handed it over
            </Button>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <p className="text-xs text-body">
              Only after verifying the customer’s identity out of band. Never send it by email.
              Issuing replaces any open grant.
            </p>
            <Field label="Reason (required)" htmlFor="grant-reason">
              <Input
                id="grant-reason"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Field label="Type the Customer ID to confirm" htmlFor="grant-confirm">
              <Input
                id="grant-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            <Field label="Your admin password" htmlFor="grant-password">
              <Input
                id="grant-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <InlineError error={issue.error ?? revoke.error} />
            <Button
              type="submit"
              loading={issue.isPending}
              disabled={reason.trim().length < 10 || !confirm || !password}
            >
              Issue recovery grant
            </Button>
            {customer.recovery.openGrantExpiresAt && (
              <Button
                type="button"
                variant="ghost"
                loading={revoke.isPending}
                onClick={() => revoke.mutate()}
              >
                Revoke open grant
              </Button>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function MarkDeletedCard({ customer }: { customer: AdminCustomerDetailDto }) {
  const refresh = useRefresh(customer.customerId);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const del = useMutation({
    mutationFn: () =>
      withAdminPassword(password, (token) =>
        apiRequest(`/admin/customers/${customer.customerId}/delete`, {
          method: 'POST',
          body: { reason, confirmCustomerId: confirm },
          headers: { 'X-Recent-Auth': token },
        }),
      ),
    onSuccess: () => void refresh(),
  });
  if (customer.status === 'DELETED') return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mark account deleted</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-body">
          Irreversible. Ends sessions and switches off emergency sharing; ownership, warranty and
          audit records are kept. Nothing is erased.
        </p>
        <Field label="Reason (required)" htmlFor="del-reason">
          <Input
            id="del-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Field label="Type the Customer ID to confirm" htmlFor="del-confirm">
          <Input id="del-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Field label="Your admin password" htmlFor="del-password">
          <Input
            id="del-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <InlineError error={del.error} />
        <Button
          variant="danger"
          loading={del.isPending}
          disabled={reason.trim().length < 10 || !confirm || !password}
          onClick={() => del.mutate()}
        >
          Mark deleted
        </Button>
      </CardContent>
    </Card>
  );
}

function SecurityEventsCard({ customerId }: { customerId: string }) {
  const events = useQuery({
    queryKey: ['customers', 'detail', customerId, 'events'],
    queryFn: () =>
      api.get<AdminSecurityEventDto[]>(`/admin/customers/${customerId}/security-events`),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Security events</CardTitle>
      </CardHeader>
      <CardContent>
        {events.isLoading && <LoadingState />}
        {events.data?.length === 0 && <p className="text-sm text-body">No events.</p>}
        <ul className="flex flex-col divide-y divide-hairline text-sm">
          {events.data?.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span>{e.label}</span>
              <span className="text-body">
                {formatDateTime(e.createdAt)}
                {e.device ? ` · ${e.device}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
