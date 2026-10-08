import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type CursorPage,
  Permission,
  RISK_ALERT_LABELS,
  type RiskAlertDto,
  RiskAlertStatus,
  RiskAlertType,
} from '@helmet/types';
import { Badge, Button, humanizeEnum, Input, Select } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { formatDateTime } from '../../lib/format';
import { AnalyticsTabs, Disclaimer, RiskLevelBadge } from './shared';

export function RiskAlertsPage() {
  const [status, setStatus] = useState<RiskAlertStatus | 'OPEN_ANY' | ''>('OPEN_ANY');
  const [type, setType] = useState<RiskAlertType | ''>('');
  const q = useInfiniteQuery({
    queryKey: ['risk-alerts', status, type],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<CursorPage<RiskAlertDto>>('/admin/risk-alerts', {
        status: status || undefined,
        type: type || undefined,
        cursor: pageParam,
        limit: 20,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Deduplicated operational alerts. Customers are never notified automatically."
      />
      <AnalyticsTabs />
      <Disclaimer />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select
          aria-label="Alert status"
          className="max-w-[12rem]"
          value={status}
          onChange={(e) => setStatus(e.target.value as RiskAlertStatus | 'OPEN_ANY' | '')}
        >
          <option value="OPEN_ANY">Needs attention</option>
          <option value="">All</option>
          {Object.values(RiskAlertStatus).map((s) => (
            <option key={s} value={s}>
              {humanizeEnum(s)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Alert type"
          className="max-w-[16rem]"
          value={type}
          onChange={(e) => setType(e.target.value as RiskAlertType | '')}
        >
          <option value="">All types</option>
          {Object.values(RiskAlertType).map((t) => (
            <option key={t} value={t}>
              {RISK_ALERT_LABELS[t]}
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading && <LoadingState />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && items.length === 0 && (
        <EmptyState title="No alerts" description="Nothing matches these filters." />
      )}
      <ul className="flex flex-col gap-3">
        {items.map((a) => (
          <AlertCard key={a.id} alert={a} />
        ))}
      </ul>
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

const OPEN: RiskAlertStatus[] = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'];

export function AlertCard({ alert }: { alert: RiskAlertDto }) {
  const qc = useQueryClient();
  const { admin } = useAuth();
  const [reason, setReason] = useState('');
  const update = useMutation({
    mutationFn: (body: {
      status?: RiskAlertStatus;
      assignedAdminId?: string | null;
      resolutionReason?: string;
    }) => api.patch<RiskAlertDto>(`/admin/risk-alerts/${alert.id}`, body),
    onSuccess: () => {
      setReason('');
      void qc.invalidateQueries({ queryKey: ['risk-alerts'] });
      void qc.invalidateQueries({ queryKey: ['helmet-analytics'] });
    },
  });
  const open = OPEN.includes(alert.status);
  return (
    <li className="rounded-xl border border-hairline bg-canvas p-4" data-testid="risk-alert">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{alert.label}</p>
          <p className="mt-1 text-sm text-body">{alert.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RiskLevelBadge level={alert.priority} />
          <Badge tone={open ? 'solid' : 'muted'} data-testid="alert-status">
            {humanizeEnum(alert.status)}
          </Badge>
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-body sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="inline">Subject: </dt>
          <dd className="inline font-mono">
            {alert.helmet ? (
              <Link
                to={`/analytics/helmets/${alert.helmet.helmetCode}`}
                className="hover:underline"
              >
                {alert.helmet.helmetCode}
              </Link>
            ) : alert.sourceRef ? (
              `source ${alert.sourceRef}`
            ) : (
              'platform'
            )}
          </dd>
        </div>
        <div>
          <dt className="inline">Observed / threshold: </dt>
          <dd className="inline tabular-nums">
            {alert.observedValue ?? '—'} / {alert.thresholdValue ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="inline">Seen: </dt>
          <dd className="inline">
            {alert.occurrences}× · last {formatDateTime(alert.lastSeenAt)}
          </dd>
        </div>
        <div>
          <dt className="inline">Assignee: </dt>
          <dd className="inline">{alert.assignee?.name ?? 'Unassigned'}</dd>
        </div>
      </dl>
      {alert.reasons.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {alert.reasons.map((r) => (
            <li key={r.type}>
              <span className="font-medium">{r.label}</span>
              <span className="text-body"> — {r.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {!open && alert.resolutionReason && (
        <p className="mt-3 text-sm text-body">
          {humanizeEnum(alert.status)} by {alert.resolvedByName ?? 'admin'}{' '}
          {formatDateTime(alert.resolvedAt)}: {alert.resolutionReason}
        </p>
      )}
      {open && (
        <RequirePermission permission={Permission.RISK_ALERT_MANAGE}>
          <div className="mt-4 flex flex-col gap-2 border-t border-hairline pt-3">
            <div className="flex flex-wrap gap-2">
              {alert.status === 'OPEN' && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={update.isPending}
                  onClick={() => update.mutate({ status: 'ACKNOWLEDGED' })}
                >
                  Acknowledge
                </Button>
              )}
              {alert.status !== 'INVESTIGATING' && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={update.isPending}
                  onClick={() => update.mutate({ status: 'INVESTIGATING' })}
                >
                  Investigate
                </Button>
              )}
              {alert.assignee?.id !== admin?.id && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={update.isPending}
                  onClick={() => update.mutate({ assignedAdminId: admin?.id ?? null })}
                >
                  Assign to me
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="Resolution reason"
                placeholder="Reason (required to resolve or dismiss)"
                className="min-w-[16rem] flex-1"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!reason.trim()}
                loading={update.isPending}
                onClick={() => update.mutate({ status: 'RESOLVED', resolutionReason: reason })}
              >
                Resolve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!reason.trim()}
                loading={update.isPending}
                onClick={() => update.mutate({ status: 'DISMISSED', resolutionReason: reason })}
              >
                Dismiss
              </Button>
            </div>
            {update.error && <InlineError error={update.error} />}
          </div>
        </RequirePermission>
      )}
    </li>
  );
}
