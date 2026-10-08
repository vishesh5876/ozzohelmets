import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AnalyticsOverviewDto } from '@helmet/types';
import { DailyChart } from '../../components/DailyChart';
import { PageHeader } from '../../components/PageHeader';
import { StatCard } from '../../components/StatCard';
import { ErrorState, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, pct } from '../../lib/format';
import { AnalyticsTabs, RangePicker, type RangeState } from './shared';

export function AnalyticsOverviewPage() {
  const [range, setRange] = useState<RangeState>({ range: '30d' });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics-overview', range],
    queryFn: () => api.get<AnalyticsOverviewDto>('/admin/analytics/overview', { ...range }),
    enabled: range.range !== 'custom' || (!!range.from && !!range.to),
  });
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Activation, emergency profiles, warranty and QR activity from daily aggregates. No medical data is used."
      />
      <AnalyticsTabs />
      <RangePicker value={range} onChange={setRange} />
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && <Overview data={data} />}
    </>
  );
}

function Overview({ data }: { data: AnalyticsOverviewDto }) {
  const c = data.current;
  const p = data.period;
  return (
    <div className="flex flex-col gap-6" data-testid="analytics-overview">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-body">Current state</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            inverted
            label="Activation rate"
            value={pct(c.activationRate)}
            hint={`${formatNumber(c.helmetsActivated)} of ${formatNumber(c.helmetsGenerated)} generated`}
          />
          <StatCard
            label="Emergency sharing"
            value={pct(c.emergencySharingRate)}
            hint={`${formatNumber(c.activeEmergencyProfiles)} active profiles`}
          />
          <StatCard
            label="Warranty registration"
            value={pct(c.warrantyRegistrationRate)}
            hint={`${formatNumber(c.warrantiesActive)} active · ${formatNumber(c.warrantiesExpired)} expired`}
          />
          <StatCard
            label="Open risk alerts"
            value={formatNumber(c.openRiskAlerts)}
            hint={`${formatNumber(c.openProductReports)} open product reports`}
          />
          <StatCard
            label="Profiles incomplete"
            value={formatNumber(c.profilesIncomplete)}
            hint={`${formatNumber(c.profilesCreated)} created · ${formatNumber(c.profilesEnabled)} enabled`}
          />
          <StatCard
            label="Owned helmets without contacts"
            value={formatNumber(c.ownedHelmetsWithoutContacts)}
          />
          <StatCard label="Proof of purchase uploaded" value={pct(c.proofUploadRate)} />
          <StatCard
            label="Avg. days printed → activated"
            value={
              c.avgDaysPrintedToActivation === null ? '—' : c.avgDaysPrintedToActivation.toFixed(1)
            }
          />
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold text-body">
          {data.range.from} – {data.range.to} (UTC)
        </h2>
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Helmets activated" value={formatNumber(p.helmetsActivated)} />
          <StatCard label="New customers" value={formatNumber(p.newCustomers)} />
          <StatCard label="Warranties registered" value={formatNumber(p.warrantiesRegistered)} />
          <StatCard label="Risk alerts opened" value={formatNumber(p.riskAlertsOpened)} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <DailyChart
            title="Public QR scans per day"
            data={data.series}
            series={[
              { key: 'emergencyScans', label: 'Emergency page' },
              { key: 'verificationScans', label: 'Verification' },
            ]}
            testId="chart-scans"
          />
          <DailyChart
            title="Helmets activated per day"
            data={data.series}
            series={[{ key: 'helmetsActivated', label: 'Activated' }]}
            testId="chart-activations"
          />
        </div>
      </section>
      <div className="grid gap-6">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-body">
            Warranty by model{data.warrantyByModel.length > 10 ? ' (top 10 by activations)' : ''}
          </h2>
          <Table>
            <THead>
              <tr>
                <Th>Model</Th>
                <Th className="text-right">Activated</Th>
                <Th className="text-right">Registered</Th>
                <Th className="text-right">Active</Th>
              </tr>
            </THead>
            <tbody>
              {data.warrantyByModel.slice(0, 10).map((m) => (
                <Tr key={m.sku}>
                  <Td>
                    {m.model} <span className="text-xs text-body">{m.sku}</span>
                  </Td>
                  <Td className="text-right tabular-nums">{formatNumber(m.activated)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(m.registered)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(m.active)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-semibold text-body">Recent activations</h2>
          <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-canvas">
            {data.recentActivations.length === 0 && (
              <li className="px-4 py-3 text-sm text-body">No activations yet.</li>
            )}
            {data.recentActivations.map((a) => (
              <li key={a.helmetId} className="flex justify-between px-4 py-3 text-sm">
                <Link
                  to={`/analytics/helmets/${a.helmetCode}`}
                  className="font-mono hover:underline"
                >
                  {a.helmetCode}
                </Link>
                <span className="text-body">{formatDateTime(a.activatedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
