import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminSafetyIdListItemDto } from '@helmet/types';
import { Badge, humanizeEnum, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';

const STATUSES = ['GENERATED', 'PRINTED', 'ACTIVATED', 'ACTIVE', 'DEACTIVATED', 'REPLACED'];

/** All Safety IDs (emergency QR identities), linked to a helmet or standalone. */
export function SafetyIdsPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const status = params.get('status') ?? '';
  const link = params.get('link') ?? '';
  const qrIntegrity = params.get('qrIntegrity') ?? '';
  const batchId = params.get('batchId') ?? '';
  const debounced = useDebounced(search);
  const [page, setPage] = useState(1);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setPage(1);
  };
  const q = useQuery({
    queryKey: ['safety-ids', debounced, status, link, qrIntegrity, batchId, page],
    queryFn: () =>
      api.page<AdminSafetyIdListItemDto>('/admin/safety-ids', {
        search: debounced || undefined,
        status: status || undefined,
        link: link || undefined,
        qrIntegrity: qrIntegrity || undefined,
        batchId: batchId || undefined,
        page,
        pageSize: 25,
      }),
  });
  return (
    <>
      <PageHeader
        title="Safety IDs"
        description="Emergency QR identities. A Safety ID may be linked to one helmet or work on its own."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Input
          className="lg:col-span-2"
          placeholder="Safety ID, Helmet ID, Customer ID or batch"
          aria-label="Search Safety IDs"
          value={search}
          onChange={(e) => set('search', e.target.value)}
        />
        <Select aria-label="Status" value={status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanizeEnum(s)}
            </option>
          ))}
        </Select>
        <Select aria-label="Link" value={link} onChange={(e) => set('link', e.target.value)}>
          <option value="">Linked or standalone</option>
          <option value="linked">Linked to a helmet</option>
          <option value="standalone">Standalone</option>
        </Select>
        <Select
          aria-label="QR integrity"
          value={qrIntegrity}
          onChange={(e) => set('qrIntegrity', e.target.value)}
        >
          <option value="">Any QR integrity</option>
          <option value="NORMAL">Normal</option>
          <option value="UNDER_REVIEW">Under review</option>
          <option value="COMPROMISED">Compromised</option>
        </Select>
      </div>
      {q.isLoading && <LoadingState />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.items.length === 0 && (
        <EmptyState title="No Safety IDs" description="Nothing matches these filters." />
      )}
      {q.data && q.data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Safety ID</Th>
                <Th>Status</Th>
                <Th>Sharing</Th>
                <Th>Owner</Th>
                <Th>Linked helmet</Th>
                <Th>Batch</Th>
                <Th>Activated</Th>
              </tr>
            </THead>
            <tbody>
              {q.data.items.map((s) => (
                <Tr key={s.id} data-testid="safety-id-row">
                  <Td>
                    <Link to={`/safety-ids/${s.id}`} className="font-mono text-xs hover:underline">
                      {s.safetyCode}
                    </Link>
                    {s.qrIntegrityStatus !== 'NORMAL' && (
                      <Badge tone="danger" className="ml-2">
                        {humanizeEnum(s.qrIntegrityStatus)}
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={s.status === 'ACTIVE' ? 'solid' : 'soft'}>
                      {humanizeEnum(s.status)}
                    </Badge>
                  </Td>
                  <Td>{s.emergencySharing ? 'On' : 'Off'}</Td>
                  <Td className="font-mono text-xs">{s.owner?.customerId ?? '—'}</Td>
                  <Td className="font-mono text-xs">
                    {s.linkedHelmet ? (
                      <Link to={`/helmets/${s.linkedHelmet.id}`} className="hover:underline">
                        {s.linkedHelmet.helmetCode}
                      </Link>
                    ) : (
                      <span className="text-body">Standalone</span>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{s.batch?.batchCode ?? '—'}</Td>
                  <Td className="text-body">{s.activatedAt ? formatDate(s.activatedAt) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination meta={q.data.meta} onPage={setPage} />
        </>
      )}
    </>
  );
}
