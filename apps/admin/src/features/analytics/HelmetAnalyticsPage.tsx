import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  type CursorPage,
  type HelmetAnalyticsDetailDto,
  type HelmetScanEventDto,
  Permission,
  QrIntegrityStatus,
} from '@helmet/types';
import { Badge, Button, HelmetStatusBadge, humanizeEnum, Select, Textarea } from '@helmet/ui';
import { DailyChart } from '../../components/DailyChart';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { StatCard } from '../../components/StatCard';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatNumber } from '../../lib/format';
import { AlertCard } from './RiskAlertsPage';
import { Disclaimer, QrIntegrityBadge, RiskLevelBadge } from './shared';

export function HelmetAnalyticsPage() {
  const { helmetCode = '' } = useParams();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['helmet-analytics', helmetCode],
    queryFn: () =>
      api.get<HelmetAnalyticsDetailDto>(
        `/admin/analytics/helmets/${encodeURIComponent(helmetCode)}`,
      ),
  });
  return (
    <>
      <PageHeader
        title={helmetCode}
        description="QR activity, review signals and product reports for this helmet."
        back={{ to: '/analytics/helmets', label: 'Helmet activity' }}
        actions={
          data && (
            <RequirePermission permission={Permission.HELMETS_READ}>
              <Link
                to={`/helmets/${data.helmet.id}`}
                className="text-sm font-medium underline-offset-2 hover:underline"
              >
                Open helmet record
              </Link>
            </RequirePermission>
          )
        }
      />
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && <Detail data={data} />}
    </>
  );
}

function Detail({ data }: { data: HelmetAnalyticsDetailDto }) {
  const { helmet, totals, risk } = data;
  return (
    <div className="flex flex-col gap-6" data-testid="helmet-analytics">
      <div className="flex flex-wrap items-center gap-2">
        <HelmetStatusBadge status={helmet.status} />
        <QrIntegrityBadge status={helmet.qrIntegrityStatus} />
        <RiskLevelBadge level={risk?.level ?? 'NONE'} score={risk?.score} />
        <Badge tone="muted">{helmet.model}</Badge>
        <Badge tone="muted">Warranty {humanizeEnum(helmet.warrantyStatus).toLowerCase()}</Badge>
        {helmet.activatedAt && (
          <Badge tone="muted">Activated {formatDate(helmet.activatedAt)}</Badge>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard inverted label="Scans, last 24 h" value={formatNumber(totals.scans24h)} />
        <StatCard
          label="Scans, last 30 days"
          value={formatNumber(totals.scans30d)}
          hint={`${formatNumber(totals.emergency30d)} emergency · ${formatNumber(totals.verify30d)} verification`}
        />
        <StatCard
          label="Distinct visitors, 7 days"
          value={formatNumber(totals.approxUniqueVisitors7d)}
          hint="approximate (daily distinct sources summed)"
        />
        <StatCard
          label="Last scan"
          value={<span className="text-display-sm">{formatDateTime(totals.lastScanAt)}</span>}
        />
      </div>
      <DailyChart
        title="Scans per day, last 30 days"
        data={data.series}
        series={[
          { key: 'emergency', label: 'Emergency page' },
          { key: 'verify', label: 'Verification' },
        ]}
        testId="chart-helmet-scans"
      />

      <section>
        <h2 className="mb-3 text-lg font-bold">Review signals</h2>
        <Disclaimer />
        {data.correlation && (
          <p
            className="mb-3 rounded-lg border border-hairline px-4 py-3 text-sm"
            data-testid="correlation"
          >
            {data.correlation}
          </p>
        )}
        {data.signals.length === 0 ? (
          <p className="text-sm text-body">No review signals for this helmet.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Signal</Th>
                <Th>Severity</Th>
                <Th className="text-right">Observed</Th>
                <Th className="text-right">Threshold</Th>
                <Th>Status</Th>
                <Th>Last detected</Th>
              </tr>
            </THead>
            <tbody>
              {data.signals.map((s) => (
                <Tr key={s.id} data-testid="risk-signal">
                  <Td className="font-medium">{s.label}</Td>
                  <Td>{humanizeEnum(s.severity)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(s.observedValue)}</Td>
                  <Td className="text-right tabular-nums">{formatNumber(s.thresholdValue)}</Td>
                  <Td>
                    <Badge tone={s.status === 'ACTIVE' ? 'solid' : 'muted'}>
                      {humanizeEnum(s.status)}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-body">
                    {formatDateTime(s.lastDetectedAt)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {risk && risk.reasons.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-sm" data-testid="risk-reasons">
            {risk.reasons.map((r) => (
              <li key={r.type}>
                <span className="font-medium">{r.label}</span>{' '}
                <span className="text-body">
                  (+{r.weight}) — {r.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
        {risk?.resolvedAt && (
          <p className="mt-2 text-sm text-body">
            Reviewed {formatDateTime(risk.resolvedAt)}: {risk.resolutionReason}
          </p>
        )}
      </section>

      {data.alerts && (
        <section>
          <h2 className="mb-3 text-lg font-bold">Alerts</h2>
          {data.alerts.length === 0 ? (
            <p className="text-sm text-body">No alerts for this helmet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.alerts.map((a) => (
                <AlertCard key={a.id} alert={a} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-bold">Product reports</h2>
        <p className="mb-2 text-sm text-body">
          {formatNumber(data.productReports.total)} total ·{' '}
          {formatNumber(data.productReports.last30d)} in the last 30 days
        </p>
        {data.productReports.recent.length > 0 && (
          <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-canvas">
            {data.productReports.recent.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
                <span>{humanizeEnum(r.reason)}</span>
                <span className="text-body">
                  {humanizeEnum(r.status)} · {formatDateTime(r.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RequirePermission permission={Permission.QR_INTEGRITY_MANAGE}>
        <QrIntegrityPanel data={data} />
      </RequirePermission>

      <ScanEvents helmetCode={helmet.helmetCode} />
    </div>
  );
}

/** Human decision only. Never changes lifecycle status or emergency access. */
function QrIntegrityPanel({ data }: { data: HelmetAnalyticsDetailDto }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<QrIntegrityStatus>(data.helmet.qrIntegrityStatus);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.patch<HelmetAnalyticsDetailDto>(
        `/admin/analytics/helmets/${encodeURIComponent(data.helmet.helmetCode)}/qr-integrity`,
        { status, note },
      ),
    onSuccess: (next) => {
      qc.setQueryData(['helmet-analytics', data.helmet.helmetCode], next);
      setNote('');
    },
  });
  return (
    <section
      className="rounded-xl border border-hairline bg-canvas p-4"
      data-testid="qr-integrity-panel"
    >
      <h2 className="text-lg font-bold">QR integrity</h2>
      <p className="mt-1 text-sm text-body">
        A separate, admin-only marker for this QR code. It never changes the helmet&apos;s lifecycle
        status and never disables the emergency page. &ldquo;Compromised&rdquo; adds a neutral
        notice to the public verification page asking the owner to contact support.
      </p>
      {data.helmet.qrIntegrityNote && (
        <p className="mt-2 text-sm">
          Current note ({formatDateTime(data.helmet.qrIntegrityChangedAt)}):{' '}
          {data.helmet.qrIntegrityNote}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:max-w-lg">
        <Select
          aria-label="QR integrity status"
          value={status}
          onChange={(e) => setStatus(e.target.value as QrIntegrityStatus)}
        >
          {Object.values(QrIntegrityStatus).map((s) => (
            <option key={s} value={s}>
              {humanizeEnum(s)}
            </option>
          ))}
        </Select>
        <Textarea
          aria-label="Note"
          placeholder="Why (at least 5 characters, audited)"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div>
          <Button
            size="sm"
            disabled={note.trim().length < 5 || status === data.helmet.qrIntegrityStatus}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save QR integrity
          </Button>
        </div>
        {save.error && <InlineError error={save.error} />}
      </div>
    </section>
  );
}

function ScanEvents({ helmetCode }: { helmetCode: string }) {
  const [open, setOpen] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ['helmet-scan-events', helmetCode],
    enabled: open,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<CursorPage<HelmetScanEventDto>>(
        `/admin/analytics/helmets/${encodeURIComponent(helmetCode)}/scans`,
        { cursor: pageParam, limit: 50 },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold">Scan events</h2>
        <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show recent scans'}
        </Button>
      </div>
      {open && (
        <>
          <p className="mb-2 text-xs text-body">
            Type, time and coarse device class only. Visitor IPs are never stored in readable form
            or shown.
          </p>
          {q.isLoading && <LoadingState />}
          {q.error && <ErrorState error={q.error} />}
          {items.length > 0 && (
            <Table>
              <THead>
                <tr>
                  <Th>Time</Th>
                  <Th>Type</Th>
                  <Th>Device class</Th>
                  <Th>Served from cache</Th>
                </tr>
              </THead>
              <tbody>
                {items.map((s) => (
                  <Tr key={s.id} data-testid="scan-event">
                    <Td className="whitespace-nowrap">{formatDateTime(s.scannedAt)}</Td>
                    <Td>{humanizeEnum(s.scanType)}</Td>
                    <Td>{s.deviceCategory ? humanizeEnum(s.deviceCategory) : '—'}</Td>
                    <Td>{s.cacheHit === null ? '—' : s.cacheHit ? 'Yes' : 'No'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          {q.data && items.length === 0 && <p className="text-sm text-body">No scans recorded.</p>}
          {q.hasNextPage && (
            <Button
              className="mt-3"
              size="sm"
              variant="secondary"
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </>
      )}
    </section>
  );
}
