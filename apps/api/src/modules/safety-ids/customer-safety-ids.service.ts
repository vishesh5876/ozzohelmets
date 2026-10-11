import { Injectable } from '@nestjs/common';
import {
  type CustomerSafetyIdDetailDto,
  type CustomerSafetyIdDto,
  ErrorCode,
  type HelmetStatus,
  SAFETY_ID_IN_USE,
  type SafetyIdStatus,
} from '@helmet/types';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EmergencyReadinessService } from '../emergency-readiness/emergency-readiness.service';
import { effectiveStatus, isoDate } from '../warranty/domain/warranty-policy';

const DAY_MS = 86_400_000;

const safetySelect = (now: Date) =>
  ({
    id: true,
    safetyCode: true,
    status: true,
    publicToken: true,
    activatedAt: true,
    helmetLinks: {
      where: { endedAt: null },
      take: 1,
      select: {
        helmet: {
          select: {
            id: true,
            helmetCode: true,
            status: true,
            helmetModel: { select: { name: true, brand: true } },
            warranty: { select: { status: true, warrantyEndDate: true } },
          },
        },
      },
    },
    transfers: {
      where: { status: 'PENDING', expiresAt: { gt: now } },
      take: 1,
      select: { expiresAt: true },
    },
  }) satisfies Prisma.SafetyIdSelect;

type SafetyRow = Prisma.SafetyIdGetPayload<{ select: ReturnType<typeof safetySelect> }>;

/**
 * Safety IDs owned by the signed-in customer. Ownership comes only from an ACTIVE
 * safety_id_ownerships row; anyone else's Safety ID is indistinguishable from a missing one.
 * Scan facts cover only the current ownership period.
 */
@Injectable()
export class CustomerSafetyIdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: EmergencyReadinessService,
    private readonly config: AppConfigService,
  ) {}

  async list(userId: string): Promise<CustomerSafetyIdDto[]> {
    const now = new Date();
    const rows = await this.prisma.safetyIdOwnership.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, safetyIdRef: { select: safetySelect(now) } },
    });
    const [switches, lastScans] = await Promise.all([
      this.readiness.safetyIdSwitches(userId),
      this.lastScans(userId),
    ]);
    return rows.map((r) =>
      this.toDto(r.safetyIdRef, r.startedAt, switches, lastScans.get(r.safetyIdRef.id) ?? null),
    );
  }

  async get(userId: string, safetyId: string): Promise<CustomerSafetyIdDto> {
    const { row, since } = await this.findOwned(userId, safetyId);
    const [switches, lastScans] = await Promise.all([
      this.readiness.safetyIdSwitches(userId),
      this.lastScans(userId),
    ]);
    return this.toDto(row, since, switches, lastScans.get(row.id) ?? null);
  }

  async detail(userId: string, safetyId: string): Promise<CustomerSafetyIdDetailDto> {
    const now = new Date();
    const { row, since } = await this.findOwned(userId, safetyId);
    const [switches, lastScans] = await Promise.all([
      this.readiness.safetyIdSwitches(userId),
      this.lastScans(userId),
    ]);
    const from = new Date(Math.max(since.getTime(), now.getTime() - 30 * DAY_MS));
    const [agg] = await this.prisma.$queryRaw<{ t: bigint; last: Date | null }[]>`
      SELECT count(*) AS t,
             max(scanned_at) FILTER (WHERE scan_type = 'EMERGENCY_PAGE') AS last
      FROM helmet_scans
      WHERE safety_id = ${row.id}::uuid AND scanned_at >= ${from} AND synthetic = false
        AND device_category IS DISTINCT FROM 'BOT'`;
    const helmet = row.helmetLinks[0]?.helmet ?? null;
    return {
      ...this.toDto(row, since, switches, lastScans.get(row.id) ?? null),
      scanSummary: {
        last30Days: Number(agg?.t ?? 0),
        lastEmergencyScanAt: agg?.last?.toISOString() ?? null,
      },
      linkedWarranty: helmet
        ? {
            status: effectiveStatus(helmet.warranty),
            endDate: helmet.warranty ? isoDate(helmet.warranty.warrantyEndDate) : null,
          }
        : null,
    };
  }

  /** "2 Safety IDs active / 1 needs setup" (active = sharing on and the QR shows the profile). */
  summary(items: CustomerSafetyIdDto[]): { total: number; active: number; needsSetup: number } {
    const usable = items.filter(
      (s) =>
        SAFETY_ID_IN_USE.includes(s.status) &&
        (!s.linkedHelmet || ['ACTIVATED', 'ACTIVE'].includes(s.linkedHelmet.status)),
    );
    const active = usable.filter((s) => s.emergencySharing).length;
    return { total: items.length, active, needsSetup: usable.length - active };
  }

  private async findOwned(
    userId: string,
    safetyId: string,
  ): Promise<{ row: SafetyRow; since: Date }> {
    const ownership = await this.prisma.safetyIdOwnership.findFirst({
      where: { userId, safetyId, status: 'ACTIVE' },
      select: { startedAt: true, safetyIdRef: { select: safetySelect(new Date()) } },
    });
    if (!ownership)
      throw AppException.notFound(ErrorCode.SAFETY_ID_NOT_FOUND, 'Safety ID not found.');
    return { row: ownership.safetyIdRef, since: ownership.startedAt };
  }

  /** Last scan per owned Safety ID, within each current ownership period (one query). */
  private async lastScans(userId: string): Promise<Map<string, Date>> {
    const rows = await this.prisma.$queryRaw<{ safety_id: string; last: Date | null }[]>`
      SELECT o.safety_id, max(s.scanned_at) AS last
      FROM safety_id_ownerships o
      JOIN helmet_scans s ON s.safety_id = o.safety_id AND s.scanned_at >= o.started_at
        AND s.synthetic = false
      WHERE o.user_id = ${userId}::uuid AND o.status = 'ACTIVE'::"OwnershipStatus"
      GROUP BY o.safety_id`;
    return new Map(rows.filter((r) => r.last).map((r) => [r.safety_id, r.last!]));
  }

  private toDto(
    row: SafetyRow,
    since: Date,
    switches: Map<string, boolean>,
    lastScanAt: Date | null,
  ): CustomerSafetyIdDto {
    const helmet = row.helmetLinks[0]?.helmet ?? null;
    const pending = row.transfers[0];
    return {
      id: row.id,
      safetyCode: row.safetyCode,
      status: row.status as SafetyIdStatus,
      emergencySharing: switches.get(row.id) ?? false,
      publicUrl: this.config.publicHelmetUrl(row.publicToken),
      activatedAt: row.activatedAt?.toISOString() ?? null,
      ownedSince: since.toISOString(),
      linkedHelmet: helmet
        ? {
            id: helmet.id,
            helmetCode: helmet.helmetCode,
            modelName: helmet.helmetModel.name,
            brand: helmet.helmetModel.brand,
            status: helmet.status as HelmetStatus,
          }
        : null,
      lastScanAt: lastScanAt?.toISOString() ?? null,
      canTransfer: helmet === null && SAFETY_ID_IN_USE.includes(row.status as SafetyIdStatus),
      pendingTransfer: pending ? { expiresAt: pending.expiresAt.toISOString() } : null,
    };
  }
}
