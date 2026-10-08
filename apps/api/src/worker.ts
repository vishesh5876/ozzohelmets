import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { type JobName } from './modules/analytics/job-runner.service';
import { JOB_NAMES, WorkerScheduler } from './worker/worker.scheduler';
import { WorkerModule } from './worker/worker.module';

/**
 * Worker entrypoint: `node dist/worker.js` (scheduled jobs) or
 * `node dist/worker.js --once <job>` (run one job and exit; for ops, CI smoke tests and backfills).
 * No HTTP server is started.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const scheduler = app.get(WorkerScheduler);
  const onceIdx = process.argv.indexOf('--once');
  if (onceIdx !== -1) {
    const job = process.argv[onceIdx + 1] as JobName;
    const jobs = job === ('all' as JobName) ? JOB_NAMES : [job];
    if (!jobs.every((j) => JOB_NAMES.includes(j))) {
      app.get(Logger).error(`Unknown job "${job}". Use one of: ${JOB_NAMES.join(', ')}, all`);
      await app.close();
      process.exit(2);
    }
    let failed = false;
    for (const j of jobs) {
      const outcome = await scheduler.runJob(j);
      app.get(Logger).log(`${j}: ${outcome.status} ${JSON.stringify(outcome.detail ?? {})}`);
      failed ||= outcome.status === 'FAILED';
    }
    await app.close();
    process.exit(failed ? 1 : 0);
  }
  scheduler.start();
  const shutdown = async () => {
    await scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void main();
