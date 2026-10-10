import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { SystemJobStatusDto, SystemStatusDto } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';
import { type GaugeSample, registry, renderGauge } from '../../infrastructure/metrics/metrics';
import type { JobName } from '../analytics/job-runner.service';

const JOBS: JobName[] = ['analytics.aggregate', 'risk.evaluate', 'retention.cleanup'];
const ALIVE_MS = 90_000;

/**
 * Operational state read from PostgreSQL (worker heartbeats, `worker_job_runs`, alerts) so the
 * API can report on the worker, which has no HTTP server. Nothing personal, no config values.
 */
@Injectable()
export class SystemStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private interval(job: JobName): number {
    switch (job) {
      case 'analytics.aggregate':
        return this.config.get('ANALYTICS_AGGREGATION_INTERVAL_MINUTES');
      case 'risk.evaluate':
        return this.config.get('RISK_EVALUATION_INTERVAL_MINUTES');
      case 'retention.cleanup':
        return this.config.get('RETENTION_INTERVAL_MINUTES');
    }
  }

  async jobs(now = new Date()): Promise<SystemJobStatusDto[]> {
    const since = new Date(now.getTime() - 86_400_000);
    return Promise.all(
      JOBS.map(async (job) => {
        const [last, lastOk, failures] = await Promise.all([
          this.prisma.workerJobRun.findFirst({ where: { job }, orderBy: { startedAt: 'desc' } }),
          this.prisma.workerJobRun.findFirst({
            where: { job, status: 'SUCCEEDED' },
            orderBy: { startedAt: 'desc' },
          }),
          this.prisma.workerJobRun.count({
            where: { job, status: 'FAILED', startedAt: { gte: since } },
          }),
        ]);
        const expected = this.interval(job);
        return {
          job,
          expectedIntervalMinutes: expected,
          lastRunAt: last?.startedAt.toISOString() ?? null,
          lastStatus: (last?.status as SystemJobStatusDto['lastStatus']) ?? null,
          lastSuccessAt: lastOk?.startedAt.toISOString() ?? null,
          lastDurationMs: lastOk?.durationMs ?? null,
          failuresLast24h: failures,
          stale: !lastOk || now.getTime() - lastOk.startedAt.getTime() > 3 * expected * 60_000,
        };
      }),
    );
  }

  async status(now = new Date()): Promise<SystemStatusDto> {
    const [jobs, beat, alive, db, cache] = await Promise.all([
      this.jobs(now),
      this.prisma.workerHeartbeat.findFirst({ orderBy: { lastBeatAt: 'desc' } }),
      this.prisma.workerHeartbeat.count({
        where: { lastBeatAt: { gte: new Date(now.getTime() - ALIVE_MS) } },
      }),
      this.prisma.$queryRaw`SELECT 1`.then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      this.redis.ping().then(
        () => 'up' as const,
        () => 'down' as const,
      ),
    ]);
    return {
      api: {
        version: this.config.get('APP_VERSION'),
        gitSha: this.config.get('GIT_SHA'),
        buildDate: this.config.get('BUILD_DATE'),
        uptimeSeconds: Math.round(process.uptime()),
      },
      worker: {
        alive,
        lastHeartbeatAt: beat?.lastBeatAt.toISOString() ?? null,
        version: beat?.version ?? null,
      },
      jobs,
      dependencies: { database: db, redis: cache },
      malwareScanning: this.config.get('MALWARE_SCAN_ENABLED'),
    };
  }

  /** Prometheus exposition: in-process counters + process stats + DB-derived gauges. */
  async prometheus(now = new Date()): Promise<string> {
    const lines = registry.render();
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    lines.push(
      ...renderGauge('helmet_process_resident_memory_bytes', 'API process RSS', [
        { value: mem.rss },
      ]),
      ...renderGauge('helmet_process_heap_used_bytes', 'API process V8 heap used', [
        { value: mem.heapUsed },
      ]),
      ...renderGauge('helmet_process_cpu_seconds', 'API process CPU time (user+system)', [
        { value: (cpu.user + cpu.system) / 1e6 },
      ]),
      ...renderGauge('helmet_process_uptime_seconds', 'API process uptime', [
        { value: process.uptime() },
      ]),
      ...renderGauge('helmet_build_info', 'Build metadata (value is always 1)', [
        {
          labels: { version: this.config.get('APP_VERSION'), git_sha: this.config.get('GIT_SHA') },
          value: 1,
        },
      ]),
    );
    try {
      const [jobs, beat, alerts] = await Promise.all([
        this.jobs(now),
        this.prisma.workerHeartbeat.findFirst({ orderBy: { lastBeatAt: 'desc' } }),
        this.prisma.riskAlert.groupBy({
          by: ['type'],
          where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] } },
          _count: { _all: true },
        }),
      ]);
      const ts = (iso: string | null) => (iso ? Date.parse(iso) / 1000 : 0);
      const perJob = (f: (j: SystemJobStatusDto) => number): GaugeSample[] =>
        jobs.map((j) => ({ labels: { job: j.job }, value: f(j) }));
      lines.push(
        ...renderGauge(
          'helmet_worker_heartbeat_timestamp_seconds',
          'Last worker heartbeat (0 = never)',
          [{ value: beat ? beat.lastBeatAt.getTime() / 1000 : 0 }],
        ),
        ...renderGauge(
          'helmet_worker_job_last_success_timestamp_seconds',
          'Last successful run per job',
          perJob((j) => ts(j.lastSuccessAt)),
        ),
        ...renderGauge(
          'helmet_worker_job_last_duration_seconds',
          'Duration of the last successful run',
          perJob((j) => (j.lastDurationMs ?? 0) / 1000),
        ),
        ...renderGauge(
          'helmet_worker_job_failures_24h',
          'Failed runs in the last 24 h',
          perJob((j) => j.failuresLast24h),
        ),
        ...renderGauge(
          'helmet_worker_job_expected_interval_seconds',
          'Configured job interval',
          perJob((j) => j.expectedIntervalMinutes * 60),
        ),
        ...renderGauge(
          'helmet_risk_alerts_open',
          'Open risk alerts by type',
          alerts.map((a) => ({ labels: { type: a.type }, value: a._count._all })),
        ),
        ...renderGauge('helmet_database_up', 'PostgreSQL reachable from the API', [{ value: 1 }]),
      );
    } catch {
      lines.push(
        ...renderGauge('helmet_database_up', 'PostgreSQL reachable from the API', [{ value: 0 }]),
      );
    }
    lines.push(
      ...renderGauge('helmet_redis_up', 'Redis reachable from the API', [
        {
          value: await this.redis.ping().then(
            () => 1,
            () => 0,
          ),
        },
      ]),
    );
    return `${lines.join('\n')}\n`;
  }
}
