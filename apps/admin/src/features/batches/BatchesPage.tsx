import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { type BatchDto, Permission } from '@helmet/types';
import { buttonVariants, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { RequirePermission } from '../../components/RequirePermission';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDate, formatNumber } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { GenerationBadge, PrintBadge, ProgressBar } from './BatchStatus';

export function BatchesPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const debounced = useDebounced(search);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['batches', page, debounced, status],
    queryFn: () =>
      api.page<BatchDto>('/admin/batches', {
        page,
        pageSize: 25,
        search: debounced,
        generationStatus: status,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) =>
      q.state.data?.items.some((b) => b.generationStatus === 'GENERATING') ? 2000 : false,
  });

  return (
    <>
      <PageHeader
        title="Manufacturing batches"
        description="Each batch generates a unique identity for every helmet produced."
        actions={
          <RequirePermission permission={Permission.BATCHES_WRITE}>
            <Link to="/batches/new" className={buttonVariants()}>
              New batch
            </Link>
          </RequirePermission>
        }
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <Input
          className="sm:max-w-xs"
          type="search"
          placeholder="Search batch code"
          aria-label="Search batches"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select
          className="sm:max-w-48"
          aria-label="Generation status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="PENDING">Not generated</option>
          <option value="GENERATING">Generating</option>
          <option value="COMPLETED">Generated</option>
          <option value="FAILED">Failed</option>
        </Select>
      </div>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && (
        <EmptyState
          title="No batches found"
          description="Create a batch to generate helmet identities."
        />
      )}
      {data && data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Batch</Th>
                <Th>Model</Th>
                <Th>Manufactured</Th>
                <Th className="w-48">Progress</Th>
                <Th>Generation</Th>
                <Th>Labels</Th>
              </tr>
            </THead>
            <tbody>
              {data.items.map((b) => (
                <Tr
                  key={b.id}
                  className="cursor-pointer hover:bg-canvas-softer"
                  onClick={() => navigate(`/batches/${b.id}`)}
                >
                  <Td>
                    <Link
                      to={`/batches/${b.id}`}
                      className="whitespace-nowrap font-mono text-sm font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {b.batchCode}
                    </Link>
                  </Td>
                  <Td>
                    <p className="font-medium">{b.helmetModel.name}</p>
                    <p className="whitespace-nowrap font-mono text-xs text-body">
                      {b.helmetModel.sku}
                    </p>
                  </Td>
                  <Td className="text-body">{formatDate(b.manufacturingDate)}</Td>
                  <Td>
                    <ProgressBar value={b.generatedCount} max={b.quantity} />
                    <p className="mt-1 text-xs tabular-nums text-body">
                      {formatNumber(b.generatedCount)} / {formatNumber(b.quantity)}
                    </p>
                  </Td>
                  <Td>
                    <GenerationBadge status={b.generationStatus} />
                  </Td>
                  <Td>
                    <PrintBadge status={b.printStatus} />
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
