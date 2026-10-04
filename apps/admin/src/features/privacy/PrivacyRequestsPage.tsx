import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountDeletionStatus, type AdminPrivacyRequestDto, Permission } from '@helmet/types';
import { Badge, Button, humanizeEnum, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { withAdminPassword } from '../../lib/admin-reauth';
import { api, apiRequest } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

/** Customer account-deletion requests. No automatic erasure; SUPER_ADMIN processes them. */
export function PrivacyRequestsPage() {
  const [status, setStatus] = useState<AccountDeletionStatus | ''>('REQUESTED');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['privacy-requests', status],
    queryFn: () =>
      api.get<AdminPrivacyRequestDto[]>('/admin/privacy-requests', {
        status: status || undefined,
      }),
  });
  return (
    <>
      <PageHeader
        title="Privacy requests"
        description="Account deletion requests from customers. Completing a request marks the account deleted; records required for product safety are retained."
      />
      <div className="mb-4">
        <Select
          className="max-w-[12rem]"
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AccountDeletionStatus | '')}
        >
          <option value="">All</option>
          {Object.values(AccountDeletionStatus).map((s) => (
            <option key={s} value={s}>
              {humanizeEnum(s)}
            </option>
          ))}
        </Select>
      </div>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.length === 0 && (
        <EmptyState title="No privacy requests" description="Nothing waiting for review." />
      )}
      {data && data.length > 0 && (
        <Table>
          <THead>
            <tr>
              <Th>Customer ID</Th>
              <Th>Type</Th>
              <Th>Requested</Th>
              <Th>Status</Th>
              <Th>Reason</Th>
              <Th>Actions</Th>
            </tr>
          </THead>
          <tbody>
            {data.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

function RequestRow({ request }: { request: AdminPrivacyRequestDto }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const done = () => qc.invalidateQueries({ queryKey: ['privacy-requests'] });
  const review = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      api.post(`/admin/privacy-requests/${request.id}/${action}`, {}),
    onSuccess: done,
  });
  const complete = useMutation({
    mutationFn: () =>
      withAdminPassword(password, (token) =>
        apiRequest(`/admin/privacy-requests/${request.id}/complete`, {
          method: 'POST',
          body: {},
          headers: { 'X-Recent-Auth': token },
        }),
      ),
    onSuccess: done,
  });
  const open = request.status === 'REQUESTED' || request.status === 'APPROVED';
  return (
    <Tr data-testid="privacy-request">
      <Td className="font-mono text-xs">
        <Link to={`/customers/${request.customerId}`} className="hover:underline">
          {request.customerId}
        </Link>
      </Td>
      <Td>Account deletion</Td>
      <Td className="whitespace-nowrap text-body">{formatDateTime(request.requestedAt)}</Td>
      <Td>
        <Badge tone={open ? 'solid' : 'muted'}>{humanizeEnum(request.status)}</Badge>
        {request.reviewedByName && (
          <p className="mt-1 text-xs text-body">by {request.reviewedByName}</p>
        )}
      </Td>
      <Td className="max-w-xs whitespace-pre-wrap break-words text-sm">{request.reason ?? '—'}</Td>
      <Td>
        <RequirePermission
          permission={Permission.PRIVACY_REQUESTS_MANAGE}
          fallback={<span className="text-xs text-body">SUPER_ADMIN processes requests</span>}
        >
          {open && (
            <div className="flex flex-col gap-2">
              {request.status === 'REQUESTED' && (
                <Button
                  size="sm"
                  loading={review.isPending}
                  onClick={() => review.mutate('approve')}
                >
                  Approve
                </Button>
              )}
              {request.status === 'APPROVED' && (
                <>
                  <Input
                    aria-label="Your admin password"
                    type="password"
                    placeholder="Your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!password}
                    loading={complete.isPending}
                    onClick={() => complete.mutate()}
                  >
                    Complete (mark deleted)
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                loading={review.isPending}
                onClick={() => review.mutate('reject')}
              >
                Reject
              </Button>
              <InlineError error={review.error ?? complete.error} />
            </div>
          )}
        </RequirePermission>
      </Td>
    </Tr>
  );
}
