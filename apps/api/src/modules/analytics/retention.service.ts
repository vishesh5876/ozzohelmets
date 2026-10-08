import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecurityEventsService } from '../customer-security/security-events.service';

const DAY_MS = 86_400_000;
const BATCH = 10_000;

export interface RetentionResult {
  scansDeleted: number;
  securityEventsDeleted: number;
  jobRunsDeleted: number;
  aggregatesDeleted: number;
}

/**
 * Retention for high-volume operational data only. It never touches ownership, manufacturing,
 * warranty, audit, alert or risk-assessment history. Detailed scans are deleted in batches so a
 * large backlog never holds long locks; recent days (≥ 2) are always kept for aggregation.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly securityEvents: SecurityEventsService,
  ) {}

  async run(now = new Date()): Promise<RetentionResult> {
    const scanDays = Math.max(this.config.get('SCAN_DETAIL_RETENTION_DAYS'), 2);
    const scanCutoff = new Date(now.getTime() - scanDays * DAY_MS);
    let scansDeleted = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM helmet_scans WHERE id IN (
          SELECT id FROM helmet_scans WHERE scanned_at < ${scanCutoff} LIMIT ${BATCH})`;
      scansDeleted += n;
      if (n < BATCH) break;
    }
    const securityEventsDeleted = await this.securityEvents.purgeExpired(now);
    const jobRunsDeleted = (
      await this.prisma.workerJobRun.deleteMany({
        where: {
          startedAt: {
            lt: new Date(now.getTime() - this.config.get('WORKER_JOB_RUN_RETENTION_DAYS') * DAY_MS),
          },
        },
      })
    ).count;
    const aggregateDays = this.config.get('ANALYTICS_AGGREGATE_RETENTION_DAYS');
    const aggregatesDeleted =
      aggregateDays > 0
        ? (
            await this.prisma.helmetScanDaily.deleteMany({
              where: { date: { lt: new Date(now.getTime() - aggregateDays * DAY_MS) } },
            })
          ).count
        : 0;
    return { scansDeleted, securityEventsDeleted, jobRunsDeleted, aggregatesDeleted };
  }
}
