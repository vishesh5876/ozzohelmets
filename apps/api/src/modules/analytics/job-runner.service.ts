import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export type JobName = 'analytics.aggregate' | 'risk.evaluate' | 'retention.cleanup';

export interface JobOutcome {
  job: JobName;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  detail?: unknown;
}

/**
 * Runs a job at most once at a time across every worker (and API instance) using a PostgreSQL
 * transaction-scoped advisory lock: a second runner gets SKIPPED instead of duplicating work.
 * Jobs are idempotent anyway, so a crash mid-run is fixed by the next run. Each run is recorded
 * in `worker_job_runs`.
 */
@Injectable()
export class JobRunnerService {
  private readonly logger = new Logger(JobRunnerService.name);
  private readonly worker = `${hostname()}:${process.pid}`;

  constructor(private readonly prisma: PrismaService) {}

  async run(job: JobName, work: () => Promise<unknown>, maxMinutes = 15): Promise<JobOutcome> {
    const started = Date.now();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${`helmet-job:${job}`})) AS locked`;
          if (!lock?.locked) return { job, status: 'SKIPPED' as const, durationMs: 0 };
          const run = await this.prisma.workerJobRun.create({
            data: { job, status: 'RUNNING', startedAt: new Date(started), worker: this.worker },
          });
          try {
            const detail = await work();
            const durationMs = Date.now() - started;
            await this.prisma.workerJobRun.update({
              where: { id: run.id },
              data: {
                status: 'SUCCEEDED',
                finishedAt: new Date(),
                durationMs,
                detail: (detail ?? null) as Prisma.InputJsonValue,
              },
            });
            return { job, status: 'SUCCEEDED' as const, durationMs, detail };
          } catch (err) {
            const durationMs = Date.now() - started;
            await this.prisma.workerJobRun.update({
              where: { id: run.id },
              data: {
                status: 'FAILED',
                finishedAt: new Date(),
                durationMs,
                detail: { error: (err as Error).message.slice(0, 500) },
              },
            });
            throw err;
          }
        },
        { timeout: maxMinutes * 60_000, maxWait: 10_000 },
      );
    } catch (err) {
      this.logger.error(`Job ${job} failed: ${(err as Error).message}`);
      return {
        job,
        status: 'FAILED',
        durationMs: Date.now() - started,
        detail: { error: (err as Error).message },
      };
    }
  }
}
