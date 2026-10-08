import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScanAnalyticsDto, ScanCountsDto } from '@helmet/types';
import { DailyChart } from '../../components/DailyChart';
import { PageHeader } from '../../components/PageHeader';
import { StatCard } from '../../components/StatCard';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { AnalyticsTabs, RangePicker, type RangeState, RiskLevelBadge } from './shared';

const counts = (c: ScanCountsDto) =>
  `${formatNumber(c.emergency)} emergency · ${formatNumber(c.verify)} verification`;

export function ScanAnalyticsPage() {
  const [range, setRange] = useState<RangeState>({ range: '30d' });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics-scans', range],
    queryFn: () => api.get<ScanAnalyticsDto>('/admin/analytics/scans', { ...range }),
    enabled: range.range !== 'custom' || (!!range.from && !!range.to),
  });
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Public QR scans by people (known bots are counted separately and excluded). Visitor identities are never shown."
      />
      <AnalyticsTabs />
      <RangePicker value={range} onChange={setRange} />
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && (
        <div className="flex flex-col gap-6" data-testid="scan-analytics">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard inverted label="Scans today" value={formatNumber(data.today.total)} hint={counts(data.today)} />
            <StatCard label="Last 7 days" value={formatNumber(data.last7d.total)} hint={counts(data.last7d)} />
            <StatCard label="Last 30 days" value={formatNumber(data.last30d.total)} hint={counts(data.last30d)} />
            <StatCard
              label="Unusual activity"
              value={formatNumber(data.helmetsWithUnusualActivity)}
              hint="helmets with active review signals"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Scans in period" value={formatNumber(data.period.total)} hint={counts(data.period)} />
            <StatCard label="Helmets scanned in period" value={formatNumber(data.uniqueHelmetsScannedInPeriod)} />
            <StatCard
              label="Unknown-code requests"
              value={formatNumber(data.invalidTokenRequestsInPeriod)}
              hint="counts only; attempted codes are never stored"
            />
          </div>
          <DailyChart
            title="Scans per day"
            data={data.series}
            series={[
              { key: 'emergency', label: 'Emergency page' },
              { key: 'verify', label: 'Verification' },
            ]}
            testId="chart-scan-trend"
          />
          <section>
            <h2 className="mb-3 text-sm font-semibold text-body">Most scanned helmets in period</h2>
            {data.topHelmets.length === 0 ? (
              <EmptyState title="No scans in this period" description="Try a longer range." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Helmet</Th>
                    <Th>Model</Th>
                    <Th className="text-right">Scans</Th>
                    <Th className="text-right">Emergency</Th>
                    <Th className="text-right">Verification</Th>
                    <Th>Signals</Th>
                  </tr>
                </THead>
                <tbody>
                  {data.topHelmets.map((h) => (
                    <Tr key={h.helmetId}>
                      <Td className="font-mono text-xs">
                        <Link to={`/analytics/helmets/${h.helmetCode}`} className="hover:underline">
                          {h.helmetCode}
                        </Link>
                      </Td>
                      <Td>{h.model}</Td>
                      <Td className="text-right tabular-nums">{formatNumber(h.scans)}</Td>
                      <Td className="text-right tabular-nums">{formatNumber(h.emergency)}</Td>
                      <Td className="text-right tabular-nums">{formatNumber(h.verify)}</Td>
                      <Td>
                        <RiskLevelBadge level={h.riskLevel} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </div>
      )}
    </>
  );
}
