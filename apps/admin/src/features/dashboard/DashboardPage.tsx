import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { type DashboardStatsDto, HELMET_STATUSES, Permission } from '@helmet/types';
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  HelmetStatusBadge,
  humanizeEnum,
} from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { StatCard } from '../../components/StatCard';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { formatDate, formatNumber } from '../../lib/format';
import { OperationsPanel } from './OperationsPanel';
import { SystemStatusCard } from './SystemStatusCard';

export function DashboardPage() {
  const { admin } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardStatsDto>('/admin/dashboard'),
  });

  return (
    <>
      <PageHeader
        title={`Good to see you, ${admin?.name.split(' ')[0] ?? ''}`}
        description="Operations, manufacturing and helmet identity at a glance."
        actions={
          <RequirePermission permission={Permission.BATCHES_WRITE}>
            <Link to="/batches/new" className={buttonVariants()}>
              New batch
            </Link>
          </RequirePermission>
        }
      />
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && (
        <div className="flex flex-col gap-6">
          <OperationsPanel />
          <SystemStatusCard />
          <h2 className="text-display-sm font-bold">Manufacturing</h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Helmets" value={formatNumber(data.helmets)} inverted />
            <StatCard
              label="Activated"
              value={formatNumber(data.activatedHelmets)}
              hint={
                data.helmets
                  ? `${((data.activatedHelmets / data.helmets) * 100).toFixed(1)}% of all helmets`
                  : undefined
              }
            />
            <StatCard label="Batches" value={formatNumber(data.batches)} />
            <StatCard label="Helmet models" value={formatNumber(data.helmetModels)} />
          </div>
          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Helmets by status</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3">
                  {HELMET_STATUSES.filter((s) => data.helmetsByStatus[s]).map((status) => {
                    const count = data.helmetsByStatus[status] ?? 0;
                    const pct = data.helmets ? (count / data.helmets) * 100 : 0;
                    return (
                      <li
                        key={status}
                        className="grid grid-cols-[8rem_1fr_4rem] items-center gap-3"
                      >
                        <HelmetStatusBadge status={status} />
                        <div
                          className="h-2 overflow-hidden rounded-pill bg-canvas-soft"
                          aria-hidden
                        >
                          <div
                            className="h-full rounded-pill bg-ink"
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                        <span className="text-right text-sm tabular-nums">
                          {formatNumber(count)}
                        </span>
                      </li>
                    );
                  })}
                  {data.helmets === 0 && (
                    <li className="text-sm text-body">No helmets generated yet.</li>
                  )}
                </ul>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Recent batches</CardTitle>
                <Link to="/batches">
                  <Button variant="ghost" size="sm">
                    View all
                  </Button>
                </Link>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col divide-y divide-hairline">
                  {data.recentBatches.map((b) => (
                    <li key={b.id}>
                      <Link
                        to={`/batches/${b.id}`}
                        className="flex items-center justify-between gap-3 py-3 hover:opacity-80"
                      >
                        <div>
                          <p className="font-mono text-sm font-medium">{b.batchCode}</p>
                          <p className="text-xs text-body">
                            {formatNumber(b.generatedCount)} / {formatNumber(b.quantity)} ·{' '}
                            {formatDate(b.createdAt)}
                          </p>
                        </div>
                        <Badge
                          tone={
                            b.generationStatus === 'COMPLETED'
                              ? 'solid'
                              : b.generationStatus === 'FAILED'
                                ? 'danger'
                                : 'soft'
                          }
                        >
                          {humanizeEnum(b.generationStatus)}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                  {data.recentBatches.length === 0 && (
                    <li className="py-3 text-sm text-body">No batches yet.</li>
                  )}
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
