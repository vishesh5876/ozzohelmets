import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { HelmetListItemDto, HelmetStatus } from '@helmet/types';
import { HelmetStatusBadge } from '@helmet/ui';
import { Pagination } from '../../components/Pagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';

export interface HelmetFilters {
  search?: string;
  status?: HelmetStatus[];
  batchId?: string;
  helmetModelId?: string;
  activated?: boolean;
}

export function HelmetTable({
  fixedFilters = {},
  pageSize = 25,
}: {
  fixedFilters?: HelmetFilters;
  pageSize?: number;
}) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [lastFilters, setLastFilters] = useState(JSON.stringify(fixedFilters));
  const filterKey = JSON.stringify(fixedFilters);
  if (filterKey !== lastFilters) {
    setLastFilters(filterKey);
    setPage(1);
  }

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['helmets', fixedFilters, page, pageSize],
    queryFn: () =>
      api.page<HelmetListItemDto>('/admin/helmets', { ...fixedFilters, page, pageSize }),
    placeholderData: keepPreviousData,
  });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data || data.items.length === 0)
    return <EmptyState title="No helmets match" description="Try a different search or filter." />;

  return (
    <div aria-busy={isFetching}>
      <Table>
        <THead>
          <tr>
            <Th>Helmet ID</Th>
            <Th>Serial number</Th>
            <Th>Model</Th>
            <Th>Batch</Th>
            <Th>Status</Th>
            <Th>Activated</Th>
          </tr>
        </THead>
        <tbody>
          {data.items.map((h) => (
            <Tr
              key={h.id}
              className="cursor-pointer hover:bg-canvas-softer"
              onClick={() => navigate(`/helmets/${h.id}`)}
            >
              <Td>
                <Link
                  to={`/helmets/${h.id}`}
                  className="whitespace-nowrap font-mono text-sm font-medium hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {h.helmetCode}
                </Link>
              </Td>
              <Td className="whitespace-nowrap font-mono text-xs text-body">{h.serialNumber}</Td>
              <Td>{h.helmetModel.name}</Td>
              <Td className="whitespace-nowrap font-mono text-xs">{h.batch.batchCode}</Td>
              <Td>
                <HelmetStatusBadge status={h.status} />
              </Td>
              <Td className="text-body">{formatDate(h.activatedAt)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Pagination meta={data.meta} onPage={setPage} />
    </div>
  );
}
