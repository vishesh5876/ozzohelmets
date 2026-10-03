import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  type BatchDto,
  HELMET_STATUSES,
  type HelmetModelDto,
  type HelmetStatus,
} from '@helmet/types';
import { Button, humanizeEnum, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/use-debounced';
import { type HelmetFilters, HelmetTable } from './HelmetTable';

const VIEWS: Record<string, { title: string; description: string; filters: HelmetFilters }> = {
  activated: {
    title: 'Activated helmets',
    description: 'Helmets that have been activated by a customer.',
    filters: { activated: true },
  },
  unactivated: {
    title: 'Unactivated helmets',
    description: 'Helmets that have never been activated.',
    filters: { activated: false },
  },
  lost: {
    title: 'Lost helmets',
    description: 'Reported lost by their owner or support.',
    filters: { status: ['LOST'] },
  },
  stolen: {
    title: 'Stolen helmets',
    description: 'Reported stolen.',
    filters: { status: ['STOLEN'] },
  },
  recalled: {
    title: 'Recalled helmets',
    description: 'Subject to a product recall.',
    filters: { status: ['RECALLED'] },
  },
};

export function HelmetsPage() {
  const { view } = useParams();
  const preset = view ? VIEWS[view] : undefined;
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const debouncedSearch = useDebounced(search);
  const status = params.get('status') ?? '';
  const batchId = params.get('batchId') ?? '';
  const helmetModelId = params.get('helmetModelId') ?? '';

  const models = useQuery({
    queryKey: ['helmet-models', 'filter-options'],
    queryFn: () => api.page<HelmetModelDto>('/admin/helmet-models', { pageSize: 100 }),
  });
  const batches = useQuery({
    queryKey: ['batches', 'filter-options'],
    queryFn: () => api.page<BatchDto>('/admin/batches', { pageSize: 100 }),
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const filters = useMemo<HelmetFilters>(
    () => ({
      ...preset?.filters,
      search: debouncedSearch || undefined,
      ...(status ? { status: [status as HelmetStatus] } : {}),
      batchId: batchId || undefined,
      helmetModelId: helmetModelId || undefined,
    }),
    [preset, debouncedSearch, status, batchId, helmetModelId],
  );

  const hasFilters = Boolean(search || status || batchId || helmetModelId);

  return (
    <>
      <PageHeader
        title={preset?.title ?? 'All helmets'}
        description={
          preset?.description ??
          'Search by Helmet ID or serial number, or filter by status, batch and model.'
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <Input
          type="search"
          placeholder="HM-XXXX-XXXX or serial number"
          aria-label="Search helmets"
          value={search}
          onChange={(e) => setParam('search', e.target.value)}
        />
        {!preset?.filters.status && (
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => setParam('status', e.target.value)}
          >
            <option value="">All statuses</option>
            {HELMET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanizeEnum(s)}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Batch"
          value={batchId}
          onChange={(e) => setParam('batchId', e.target.value)}
        >
          <option value="">All batches</option>
          {batches.data?.items.map((b) => (
            <option key={b.id} value={b.id}>
              {b.batchCode}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Model"
          value={helmetModelId}
          onChange={(e) => setParam('helmetModelId', e.target.value)}
        >
          <option value="">All models</option>
          {models.data?.items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.sku})
            </option>
          ))}
        </Select>
        {hasFilters && (
          <Button variant="ghost" onClick={() => setParams({}, { replace: true })}>
            Clear
          </Button>
        )}
      </div>
      <HelmetTable fixedFilters={filters} />
    </>
  );
}
