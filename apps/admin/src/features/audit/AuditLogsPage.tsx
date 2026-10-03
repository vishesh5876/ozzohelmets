import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditLogDto } from '@helmet/types';
import { Badge, Input } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';

export function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const debounced = useDebounced(action.trim());
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit-logs', page, debounced],
    queryFn: () =>
      api.page<AuditLogDto>('/admin/audit-logs', { page, pageSize: 50, action: debounced }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Audit logs"
        description="Append-only record of security-relevant actions. IP addresses are stored as keyed hashes."
      />
      <div className="mb-4 max-w-sm">
        <Input
          placeholder="Filter by exact action, e.g. batch.export.manufacturing_csv"
          aria-label="Filter by action"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && <EmptyState title="No audit entries" />}
      {data && data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Entity</Th>
                <Th>Details</Th>
              </tr>
            </THead>
            <tbody>
              {data.items.map((log) => (
                <Tr key={log.id}>
                  <Td className="whitespace-nowrap text-body">{formatDateTime(log.createdAt)}</Td>
                  <Td>
                    <Badge
                      tone={
                        log.action.includes('failed') ||
                        log.action.includes('reuse') ||
                        log.action.includes('locked')
                          ? 'danger'
                          : log.action.includes('export')
                            ? 'solid'
                            : 'soft'
                      }
                    >
                      {log.action}
                    </Badge>
                  </Td>
                  <Td>
                    {log.admin ? (
                      <span title={log.admin.email}>{log.admin.name}</span>
                    ) : (
                      <span className="text-body">System</span>
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
