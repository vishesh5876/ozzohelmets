import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { OperationsDashboardDto } from '@helmet/types';
import { Card, CardContent, CardHeader, CardTitle } from '@helmet/ui';
import { StatCard } from '../../components/StatCard';
import { ErrorState } from '../../components/States';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';

/** Operational counters + recent activations (and security events for SUPER_ADMIN). */
export function OperationsPanel() {
  const { data, error, refetch } = useQuery({
    queryKey: ['dashboard', 'operations'],
    queryFn: () => api.get<OperationsDashboardDto>('/admin/dashboard/operations'),
  });
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return null;
  return (
    <section aria-labelledby="ops-h" className="flex flex-col gap-4">
      <h2 id="ops-h" className="text-display-sm font-bold">
        Operations
      </h2>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="operations">
        <StatCard label="Total helmets" value={formatNumber(data.totalHelmets)} inverted />
        <StatCard label="Activated" value={formatNumber(data.activatedHelmets)} />
        <StatCard label="Unactivated" value={formatNumber(data.unactivatedHelmets)} />
        <StatCard
          label="Emergency profiles active"
          value={formatNumber(data.activeEmergencyProfiles)}
        />
        <StatCard label="Lost / stolen" value={formatNumber(data.lostOrStolen)} />
        <StatCard label="Damaged" value={formatNumber(data.damaged)} />
        <StatCard label="Warranties active" value={formatNumber(data.warrantiesActive)} />
        <StatCard
          label="Open product reports"
          value={formatNumber(data.productReportsOpen)}
          hint={
            data.pendingPrivacyRequests
              ? `${data.pendingPrivacyRequests} privacy request(s) open`
              : undefined
          }
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent activations</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentActivations.length === 0 ? (
              <p className="text-sm text-body">No activations yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline text-sm">
                {data.recentActivations.map((a) => (
                  <li key={a.helmetId} className="flex justify-between gap-2 py-2">
                    <Link to={`/helmets/${a.helmetId}`} className="font-mono hover:underline">
                      {a.helmetCode}
                    </Link>
                    <span className="text-body">{formatDateTime(a.activatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        {data.recentSecurityEvents && (
          <Card>
            <CardHeader>
              <CardTitle>Recent security events</CardTitle>
            </CardHeader>
            <CardContent>
              {data.recentSecurityEvents.length === 0 ? (
                <p className="text-sm text-body">No security events yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-hairline text-sm">
                  {data.recentSecurityEvents.map((e) => (
                    <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span>
                        {e.label} ·{' '}
                        <Link
                          to={`/customers/${e.customerId}`}
                          className="font-mono hover:underline"
                        >
                          {e.customerId}
                        </Link>
                      </span>
                      <span className="text-body">{formatDateTime(e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}
