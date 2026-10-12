import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CursorPage, RiskLevel, SafetyIdActivityItemDto } from '@helmet/types';
import { Badge, Button, HelmetStatusBadge, humanizeEnum, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import { AnalyticsTabs, Disclaimer, QrIntegrityBadge, RiskLevelBadge } from './shared';

/** Phase 9: QR activity per Safety ID (the scanned code), with the linked helmet for context. */
export function HelmetActivityPage() {
  const [minLevel, setMinLevel] = useState<RiskLevel | ''>('');
  const [includeResolved, setIncludeResolved] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ['analytics-safety-ids', minLevel, includeResolved],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<CursorPage<SafetyIdActivityItemDto>>('/admin/analytics/safety-ids', {
        minLevel: minLevel || undefined,
        includeResolved: includeResolved || undefined,
        cursor: pageParam,
        limit: 25,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Safety IDs whose recent QR scan pattern produced review signals, highest score first."
      />
      <AnalyticsTabs />
      <Disclaimer />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          aria-label="Minimum level"
          className="max-w-[12rem]"
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as RiskLevel | '')}
        >
          <option value="">Any level</option>
          <option value="LOW">Low and above</option>
          <option value="MEDIUM">Medium and above</option>
          <option value="HIGH">High and above</option>
          <option value="CRITICAL">Critical</option>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setIncludeResolved(e.target.checked)}
          />
          Include reviewed
        </label>
      </div>
      {q.isLoading && <LoadingState />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && items.length === 0 && (
        <EmptyState
          title="No unusual activity"
          description="No Safety ID currently has review signals."
        />
      )}
      {items.length > 0 && (
        <Table>
          <THead>
            <tr>
              <Th>Safety ID</Th>
              <Th>Status</Th>
              <Th>Review priority</Th>
              <Th className="text-right">Scans 24 h</Th>
              <Th className="text-right">Scans 7 d</Th>
              <Th className="text-right">Open alerts</Th>
              <Th>Last scan</Th>
            </tr>
          </THead>
          <tbody>
            {items.map((h) => (
              <Tr key={h.safetyId} data-testid="activity-row">
                <Td>
                  <Link
                    to={`/analytics/safety-ids/${h.safetyCode}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {h.safetyCode}
                  </Link>
                  <p className="text-xs text-body">
                    {h.linkedHelmet
                      ? `${h.linkedHelmet.helmetCode} · ${h.linkedHelmet.model}`
                      : 'Standalone'}
                  </p>
                </Td>
                <Td className="flex flex-col items-start gap-1">
                  <Badge tone="soft">{humanizeEnum(h.status)}</Badge>
                  {h.linkedHelmet && <HelmetStatusBadge status={h.linkedHelmet.status} />}
                  <QrIntegrityBadge status={h.qrIntegrityStatus} />
                </Td>
                <Td>
                  <RiskLevelBadge level={h.riskLevel} score={h.riskScore} />
                </Td>
                <Td className="text-right tabular-nums">{formatNumber(h.scans24h)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(h.scans7d)}</Td>
                <Td className="text-right tabular-nums">{formatNumber(h.openAlerts)}</Td>
                <Td className="whitespace-nowrap text-body">{formatDateTime(h.lastScanAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {q.hasNextPage && (
        <div className="mt-4">
          <Button
            variant="secondary"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
