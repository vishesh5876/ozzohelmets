import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type AdminWarrantyListItemDto, type WarrantyStatus } from '@helmet/types';
import { Badge, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/use-debounced';
import { formatDay, STATUS_TONE } from './warranty-format';

const FILTERS: (WarrantyStatus | '')[] = ['', 'ACTIVE', 'EXPIRED', 'VOID', 'REPLACED'];

export function WarrantiesPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<WarrantyStatus | ''>('');
  const debounced = useDebounced(search.trim());
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['warranties', page, debounced, status],
    queryFn: () =>
      api.page<AdminWarrantyListItemDto>('/admin/warranties', {
        page,
        pageSize: 25,
        search: debounced || undefined,
        status: status || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Warranties"
        description="Registered helmet coverage. Expiry is derived from the end date."
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          className="max-w-sm"
          placeholder="Helmet ID, Customer ID, serial or invoice number"
          aria-label="Search warranties"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="max-w-[12rem]"
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as WarrantyStatus | '');
            setPage(1);
          }}
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f ? f.charAt(0) + f.slice(1).toLowerCase() : 'All statuses'}
            </option>
          ))}
        </Select>
      </div>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && <EmptyState title="No warranties found" />}
      {data && data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Helmet</Th>
                <Th>Status</Th>
                <Th>Purchase</Th>
                <Th>Coverage ends</Th>
                <Th>Owner</Th>
                <Th>Invoice</Th>
              </tr>
            </THead>
            <tbody>
              {data.items.map((w) => (
                <Tr key={w.id}>
                  <Td>
                    <Link
                      to={`/warranties/${w.id}`}
                      className="font-mono font-medium hover:underline"
                    >
                      {w.helmet.helmetCode}
                    </Link>
                    <p className="text-xs text-body">{w.helmet.modelName}</p>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[w.status]}>{w.status}</Badge>
                  </Td>
                  <Td>{formatDay(w.purchaseDate)}</Td>
                  <Td>{formatDay(w.endDate)}</Td>
                  <Td className="font-mono text-xs">{w.ownerCustomerId ?? '—'}</Td>
                  <Td className="font-mono text-xs">{w.invoiceNumber ?? '—'}</Td>
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
