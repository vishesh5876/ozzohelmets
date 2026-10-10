import { useQuery } from '@tanstack/react-query';
import type { SystemStatusDto } from '@helmet/types';
import { Badge } from '@helmet/ui';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

const JOB_LABELS: Record<SystemStatusDto['jobs'][number]['job'], string> = {
  'analytics.aggregate': 'Analytics aggregation',
  'risk.evaluate': 'Risk evaluation',
  'retention.cleanup': 'Retention cleanup',
};

/** Operations health: API build, worker heartbeat, last successful run of each worker job. */
export function SystemStatusCard() {
  const { data } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatusDto>('/admin/system/status'),
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const workerOk = data.worker.alive > 0;
  return (
    <section
      className="rounded-xl border border-hairline bg-canvas p-5"
      data-testid="system-status"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">System status</h2>
        <div className="flex flex-wrap gap-2">
          <Badge tone={data.dependencies.database === 'up' ? 'success' : 'danger'}>
            Database {data.dependencies.database}
          </Badge>
          <Badge tone={data.dependencies.redis === 'up' ? 'success' : 'danger'}>
            Redis {data.dependencies.redis}
          </Badge>
          <Badge tone={workerOk ? 'success' : 'danger'} data-testid="worker-status">
            {workerOk ? `Worker running (${data.worker.alive})` : 'Worker not reporting'}
          </Badge>
        </div>
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {data.jobs.map((j) => (
          <li
            key={j.job}
            className="rounded-lg bg-canvas-softer p-3 text-sm"
            data-testid="job-status"
          >
            <p className="font-medium">{JOB_LABELS[j.job]}</p>
            <p className={j.stale ? 'text-danger' : 'text-body'}>
              {j.lastSuccessAt
                ? `Last success ${formatDateTime(j.lastSuccessAt)}`
                : 'Never succeeded'}
              {j.stale ? ' · delayed' : ''}
            </p>
            {j.failuresLast24h > 0 && (
              <p className="text-danger">{j.failuresLast24h} failed run(s) in 24 h</p>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-body">
        API {data.api.version} · {data.api.gitSha.slice(0, 7)} · worker heartbeat{' '}
        {formatDateTime(data.worker.lastHeartbeatAt)}
        {data.malwareScanning ? ' · malware scanning on' : ' · malware scanning off'}
      </p>
    </section>
  );
}
