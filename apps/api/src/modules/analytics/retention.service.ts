import { Injectable } from '@nestjs/common';
import { summarizeUserAgent } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecurityEventsService } from '../customer-security/security-events.service';
import { deviceCategory } from './domain/device';

const DAY_MS = 86_400_000;
const BATCH = 10_000;
const MINIMISE_BATCH = 1_000;

export interface RetentionResult {
  scansDeleted: number;
  legacyScansMinimised: number;
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
    const legacyScansMinimised = await this.minimiseLegacyScans();
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
    return {
      scansDeleted,
      legacyScansMinimised,
      securityEventsDeleted,
      jobRunsDeleted,
      aggregatesDeleted,
    };
  }

  /**
   * Scans recorded before Phase 6 kept the raw User-Agent (≤ 255 chars). Replace it with the same
   * "Browser on OS" summary and device category new rows get, in bounded batches per run.
   * Idempotent: summarised rows have a category (or a null UA) and are not selected again.
   */
  private async minimiseLegacyScans(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const rows = await this.prisma.helmetScan.findMany({
        where: { deviceCategory: null, userAgent: { not: null } },
        select: { id: true, userAgent: true },
        take: MINIMISE_BATCH,
      });
      if (rows.length === 0) break;
      const groups = new Map<string, string[]>();
      for (const r of rows) {
        const key = JSON.stringify([
          summarizeUserAgent(r.userAgent),
          deviceCategory(r.userAgent) ?? 'OTHER',
        ]);
        groups.set(key, [...(groups.get(key) ?? []), r.id]);
      }
      for (const [key, ids] of groups) {
        const [userAgent, category] = JSON.parse(key) as [
          string | null,
          ReturnType<typeof deviceCategory>,
        ];
        await this.prisma.helmetScan.updateMany({
          where: { id: { in: ids } },
          data: { userAgent, deviceCategory: category },
        });
      }
      total += rows.length;
      if (rows.length < MINIMISE_BATCH) break;
    }
    return total;
  }
}
