import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AnalyticsAggregationService } from '../modules/analytics/analytics-aggregation.service';
import {
  type JobName,
  type JobOutcome,
  JobRunnerService,
} from '../modules/analytics/job-runner.service';
import { RetentionService } from '../modules/analytics/retention.service';
import { RiskEvaluationService } from '../modules/analytics/risk-evaluation.service';

/** Touched every 30 s while the worker runs; the container healthcheck reads its mtime. */
export const WORKER_HEARTBEAT_FILE =
  process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/helmet-worker-heartbeat';

export const JOB_NAMES: readonly JobName[] = [
  'analytics.aggregate',
  'risk.evaluate',
  'retention.cleanup',
];

/**
 * Three logical job groups on simple intervals. Every run goes through JobRunnerService (advisory
 * lock + run history), so several workers — or a restart mid-run — never duplicate work.
 */
@Injectable()
export class WorkerScheduler {
  private readonly logger = new Logger(WorkerScheduler.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly workerId = `${hostname()}:${process.pid}`;
  private readonly startedAt = new Date();

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: JobRunnerService,
    private readonly aggregation: AnalyticsAggregationService,
    private readonly risk: RiskEvaluationService,
    private readonly retention: RetentionService,
    private readonly prisma: PrismaService,
  ) {}

  /** Heartbeat row in PostgreSQL (read by metrics and the admin system status). Never throws. */
  private async beatDb(): Promise<void> {
    const now = new Date();
    await this.prisma.workerHeartbeat
      .upsert({
        where: { workerId: this.workerId },
        create: {
          workerId: this.workerId,
          hostname: hostname().slice(0, 100),
          version: this.config.get('APP_VERSION'),
          startedAt: this.startedAt,
          lastBeatAt: now,
        },
        update: { lastBeatAt: now },
      })
      .catch((err: Error) => this.logger.warn(`heartbeat write failed: ${err.message}`));
  }

  runJob(job: JobName): Promise<JobOutcome> {
    switch (job) {
      case 'analytics.aggregate':
        return this.runner.run(job, () => this.aggregation.aggregateRecent());
      case 'risk.evaluate':
        // Uses past days' aggregates only as the verification baseline; live counts come from raw scans.
        return this.runner.run(job, () => this.risk.evaluate());
      case 'retention.cleanup':
        return this.runner.run(job, () => this.retention.run(), 60);
    }
  }

  start(): void {
    const every: [JobName, number][] = [
      ['analytics.aggregate', this.config.get('ANALYTICS_AGGREGATION_INTERVAL_MINUTES')],
      ['risk.evaluate', this.config.get('RISK_EVALUATION_INTERVAL_MINUTES')],
      ['retention.cleanup', this.config.get('RETENTION_INTERVAL_MINUTES')],
    ];
    for (const [job, minutes] of every) {
      const tick = () => {
        if (this.stopping) return;
        const p = this.runJob(job)
          .then((o) => {
            if (o.status !== 'SKIPPED')
              this.logger.log(
                `${job}: ${o.status} in ${o.durationMs} ms ${JSON.stringify(o.detail ?? {})}`,
              );
          })
          .finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      };
      // Stagger first runs so the jobs don't all start at once after a deploy.
      setTimeout(tick, 2_000 + every.findIndex(([j]) => j === job) * 3_000).unref();
      this.timers.push(setInterval(tick, minutes * 60_000));
    }
    const beat = () => {
      void writeFile(WORKER_HEARTBEAT_FILE, new Date().toISOString()).catch(() => undefined);
      void this.beatDb();
    };
    beat();
    this.timers.push(setInterval(beat, 30_000));
    this.logger.log(`Worker started: ${every.map(([j, m]) => `${j} every ${m} min`).join(', ')}`);
  }

  /** Graceful shutdown: no new runs, wait for in-flight jobs (they are idempotent anyway). */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled([...this.inFlight]);
  }
}
