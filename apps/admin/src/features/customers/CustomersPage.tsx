import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type AdminCustomerSearchResponse, UserStatus } from '@helmet/types';
import { Badge, Button, humanizeEnum, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { STATUS_TONE } from './customer-format';

const PAGE_SIZE = 20;

/** Find a customer by Customer ID, Helmet ID, email or name. Operational data only. */
export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = (params.get('status') ?? '') as UserStatus | '';
  const page = Number(params.get('page') ?? 1);
  const [draft, setDraft] = useState(q);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', q, status, page],
    queryFn: () =>
      api.get<AdminCustomerSearchResponse>('/admin/customers', {
        q: q || undefined,
        status: status || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const set = (next: Record<string, string>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    setParams(merged);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    set({ q: draft.trim(), page: '' });
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Customers"
        description="Search by Customer ID, Helmet ID, email or name. Medical information is never shown here."
      />
      <form className="mb-4 flex flex-col gap-2 sm:flex-row" onSubmit={submit} role="search">
        <Input
          aria-label="Search customers"
          placeholder="CU-…, HM-…, email or name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="sm:max-w-md"
        />
        <Select
          aria-label="Account status"
          className="sm:max-w-[12rem]"
          value={status}
          onChange={(e) => set({ status: e.target.value, page: '' })}
        >
          <option value="">Any status</option>
          {Object.values(UserStatus).map((s) => (
            <option key={s} value={s}>
              {humanizeEnum(s)}
            </option>
          ))}
        </Select>
        <Button type="submit">Search</Button>
      </form>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && (
        <EmptyState
          title="No customers found"
          description={q ? 'Check the ID, or try part of the email or name.' : 'No customers yet.'}
        />
      )}
      {data && data.items.length > 0 && (
        <>
          <p className="mb-2 text-sm text-body">
            {data.total} result{data.total === 1 ? '' : 's'}
            {data.matchedBy !== 'all' ? ` · matched by ${humanizeEnum(data.matchedBy)}` : ''}
          </p>
          <Table>
            <THead>
              <tr>
                <Th>Customer ID</Th>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Status</Th>
                <Th>Helmets</Th>
                <Th>Last sign-in</Th>
              </tr>
            </THead>
            <tbody>
              {data.items.map((c) => (
                <Tr key={c.customerId} data-testid="customer-row">
                  <Td className="font-mono text-xs">
                    <Link to={`/customers/${c.customerId}`} className="font-medium hover:underline">
                      {c.customerId}
                    </Link>
                  </Td>
                  <Td>{c.name ?? '—'}</Td>
                  <Td className="break-all text-sm">{c.email ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[c.status]}>{humanizeEnum(c.status)}</Badge>
                  </Td>
                  <Td className="tabular-nums">{c.activeHelmets}</Td>
                  <Td className="whitespace-nowrap text-body">
                    {c.lastLoginAt ? formatDateTime(c.lastLoginAt) : 'Never'}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {pages > 1 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <Button
                variant="subtle"
                size="sm"
                disabled={page <= 1}
                onClick={() => set({ page: String(page - 1) })}
              >
                Previous
              </Button>
              <span>
                Page {page} of {pages}
              </span>
              <Button
                variant="subtle"
                size="sm"
                disabled={page >= pages}
                onClick={() => set({ page: String(page + 1) })}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
