import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type HelmetModelDto, Permission } from '@helmet/types';
import { Badge, Button, Input } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { RequirePermission } from '../../components/RequirePermission';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDate, formatNumber } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { ModelFormDialog } from './ModelFormDialog';

export function ModelsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [editing, setEditing] = useState<HelmetModelDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['helmet-models', page, debounced],
    queryFn: () =>
      api.page<HelmetModelDto>('/admin/helmet-models', { page, pageSize: 25, search: debounced }),
    placeholderData: keepPreviousData,
  });

  const openDialog = (model: HelmetModelDto | null) => {
    setEditing(model);
    setDialogOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Helmet models"
        description="Products and SKUs that batches are manufactured against."
        actions={
          <RequirePermission permission={Permission.MODELS_WRITE}>
            <Button onClick={() => openDialog(null)}>New model</Button>
          </RequirePermission>
        }
      />
      <div className="mb-4 max-w-sm">
        <Input
          type="search"
          placeholder="Search name or SKU"
          aria-label="Search helmet models"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && (
        <EmptyState
          title="No helmet models yet"
          description="Create a model before planning a manufacturing batch."
          action={
            <RequirePermission permission={Permission.MODELS_WRITE}>
              <Button onClick={() => openDialog(null)}>New model</Button>
            </RequirePermission>
          }
        />
      )}
      {data && data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Model</Th>
                <Th>SKU</Th>
                <Th>Brand</Th>
                <Th className="text-right">Helmets</Th>
                <Th>Status</Th>
                <Th>Created</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <tbody>
              {data.items.map((m) => (
                <Tr key={m.id}>
                  <Td className="font-medium">{m.name}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs">{m.sku}</Td>
                  <Td>{m.brand}</Td>
                  <Td className="text-right tabular-nums">
                    <Link
                      className="underline-offset-4 hover:underline"
                      to={`/helmets?helmetModelId=${m.id}`}
                    >
                      {formatNumber(m.helmetCount)}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={m.status === 'ACTIVE' ? 'solid' : 'muted'}>
                      {m.status === 'ACTIVE' ? 'Active' : 'Archived'}
                    </Badge>
                  </Td>
                  <Td className="text-body">{formatDate(m.createdAt)}</Td>
                  <Td className="text-right">
                    <RequirePermission permission={Permission.MODELS_WRITE}>
                      <Button variant="ghost" size="sm" onClick={() => openDialog(m)}>
                        Edit
                      </Button>
                    </RequirePermission>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination meta={data.meta} onPage={setPage} />
        </>
      )}
      <ModelFormDialog open={dialogOpen} onClose={() => setDialogOpen(false)} model={editing} />
    </>
  );
}
