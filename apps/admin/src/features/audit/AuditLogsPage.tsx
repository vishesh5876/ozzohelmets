import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuditLogDto } from '@helmet/types';
import { Badge, Button, Field, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';

interface Filters {
  actorType: '' | 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  action: string;
  entityType: string;
  helmetCode: string;
  customerId: string;
  from: string;
  to: string;
}

const EMPTY: Filters = {
  actorType: '',
  action: '',
  entityType: '',
  helmetCode: '',
  customerId: '',
  from: '',
  to: '',
};

const tone = (action: string) =>
  action.includes('failed') || action.includes('reuse') || action.includes('locked')
    ? 'danger'
    : action.includes('export') || action.includes('recovery_grant') || action.includes('deleted')
      ? 'solid'
      : 'soft';

export function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const debounced = useDebounced(filters);
  const query = {
    page,
    pageSize: 50,
    actorType: debounced.actorType || undefined,
    action: debounced.action.trim() || undefined,
    entityType: debounced.entityType.trim() || undefined,
    helmetCode: debounced.helmetCode.trim() || undefined,
    customerId: debounced.customerId.trim() || undefined,
    from: debounced.from ? new Date(`${debounced.from}T00:00:00`).toISOString() : undefined,
    to: debounced.to ? new Date(`${debounced.to}T23:59:59.999`).toISOString() : undefined,
  };
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit-logs', query],
    queryFn: () => api.page<AuditLogDto>('/admin/audit-logs', query),
    placeholderData: keepPreviousData,
  });
  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Audit logs"
        description="Append-only record of security-relevant actions. IP addresses are keyed hashes; secret-looking metadata is redacted."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Actor" htmlFor="f-actor">
          <Select
            id="f-actor"
            value={filters.actorType}
            onChange={(e) => set({ actorType: e.target.value as Filters['actorType'] })}
          >
            <option value="">Anyone</option>
            <option value="ADMIN">Admin</option>
            <option value="CUSTOMER">Customer</option>
            <option value="SYSTEM">System</option>
          </Select>
        </Field>
        <Field label="Action (exact)" htmlFor="f-action">
          <Input
            id="f-action"
            placeholder="e.g. customer.status.changed"
            value={filters.action}
            onChange={(e) => set({ action: e.target.value })}
          />
        </Field>
        <Field label="Entity type" htmlFor="f-entity">
          <Input
            id="f-entity"
            placeholder="helmet, user, batch…"
            value={filters.entityType}
            onChange={(e) => set({ entityType: e.target.value })}
          />
        </Field>
        <Field label="Helmet ID" htmlFor="f-helmet">
          <Input
            id="f-helmet"
            placeholder="HM-…"
            value={filters.helmetCode}
            onChange={(e) => set({ helmetCode: e.target.value })}
          />
        </Field>
        <Field label="Customer ID" htmlFor="f-customer">
          <Input
            id="f-customer"
            placeholder="CU-…"
            value={filters.customerId}
            onChange={(e) => set({ customerId: e.target.value })}
          />
        </Field>
        <Field label="From" htmlFor="f-from">
          <Input
            id="f-from"
            type="date"
            value={filters.from}
            onChange={(e) => set({ from: e.target.value })}
          />
        </Field>
        <Field label="To" htmlFor="f-to">
          <Input
            id="f-to"
            type="date"
            value={filters.to}
            onChange={(e) => set({ to: e.target.value })}
          />
        </Field>
        <div className="flex items-end">
          <Button variant="subtle" onClick={() => set(EMPTY)}>
            Clear filters
          </Button>
        </div>
      </div>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && (
        <EmptyState title="No audit entries" description="Try widening the filters." />
      )}
      {data && data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Customer</Th>
                <Th>Entity</Th>
                <Th>Details</Th>
              </tr>
            </THead>
            <tbody>
              {data.items.map((log) => (
                <Tr key={log.id} data-testid="audit-row">
                  <Td className="whitespace-nowrap text-body">{formatDateTime(log.createdAt)}</Td>
                  <Td>
                    <Badge tone={tone(log.action)}>{log.label}</Badge>
                    <p className="mt-1 font-mono text-[11px] text-body">{log.action}</p>
                  </Td>
                  <Td>
                    {log.admin ? (
                      <span title={log.admin.email}>{log.admin.name}</span>
                    ) : (
                      <span className="text-body">
                        {log.actorType === 'CUSTOMER' ? 'Customer' : 'System'}
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">
                    {log.customerId ? (
                      <Link to={`/customers/${log.customerId}`} className="hover:underline">
                        {log.customerId}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-xs">
                    {log.entityType}
                    {log.entityId ? (
                      <span className="text-body"> · {log.entityId.slice(0, 8)}</span>
                    ) : null}
                  </Td>
                  <Td
                    className="max-w-xs truncate font-mono text-xs text-body"
                    title={log.metadata ? JSON.stringify(log.metadata) : undefined}
                  >
                    {log.metadata ? JSON.stringify(log.metadata) : '—'}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination meta={data.meta} onPage={setPage} />
        </>
      )}
    </>
  );
}
