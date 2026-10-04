import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type DashboardStatsDto,
  type HelmetStatus,
  type OperationsDashboardDto,
  Permission,
  roleHasPermission,
} from '@helmet/types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { SecurityEventsService } from '../customer-security/security-events.service';

@ApiTags('admin / dashboard')
@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: SecurityEventsService,
  ) {}

  /**
   * Operational counters for the admin home page. Aggregates only (no per-customer data); recent
   * security events are included only for admins allowed to see them.
   */
  @Get('operations')
  @AdminAuth(Permission.DASHBOARD_READ)
  async operations(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<OperationsDashboardDto> {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const [byStatus, activated, customers, warrantiesActive, reportsOpen, privacy, recent] =
      await this.prisma.$transaction([
        this.prisma.helmet.groupBy({
          by: ['status'],
          _count: { _all: true },
          orderBy: { status: 'asc' },
        }),
        this.prisma.helmet.count({ where: { activatedAt: { not: null } } }),
        this.prisma.user.count({ where: { status: { not: 'DELETED' } } }),
        this.prisma.helmetWarranty.count({
          where: { status: { in: ['ACTIVE', 'EXPIRED'] }, warrantyEndDate: { gte: today } },
        }),
        this.prisma.productReport.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
        this.prisma.accountDeletionRequest.count({
          where: { status: { in: ['REQUESTED', 'APPROVED'] } },
        }),
        this.prisma.helmet.findMany({
          where: { activatedAt: { not: null } },
          orderBy: { activatedAt: 'desc' },
          take: 8,
          select: { id: true, helmetCode: true, activatedAt: true },
        }),
      ]);
    const count = (statuses: HelmetStatus[]) =>
      byStatus
        .filter((r) => statuses.includes(r.status))
        .reduce(
          (n, r) => n + (typeof r._count === 'object' && r._count ? (r._count._all ?? 0) : 0),
          0,
        );
    const total = count([...new Set(byStatus.map((r) => r.status))]);
    return {
      totalHelmets: total,
      activatedHelmets: activated,
      unactivatedHelmets: total - activated,
      activeEmergencyProfiles: count(['ACTIVE']),
      lostOrStolen: count(['LOST', 'STOLEN']),
      damaged: count(['DAMAGED']),
      warrantiesActive,
      productReportsOpen: reportsOpen,
      customers,
      pendingPrivacyRequests: privacy,
      recentActivations: recent.map((h) => ({
        helmetId: h.id,
        helmetCode: h.helmetCode,
        activatedAt: h.activatedAt!.toISOString(),
      })),
      ...(roleHasPermission(admin.role, Permission.SECURITY_EVENTS_VIEW)
        ? { recentSecurityEvents: await this.events.forAdmin({ limit: 8 }) }
        : {}),
    };
  }

  @Get()
  @AdminAuth(Permission.DASHBOARD_READ)
  async stats(): Promise<DashboardStatsDto> {
    const [helmetModels, batches, byStatus, activatedHelmets, recent] =
      await this.prisma.$transaction([
        this.prisma.helmetModel.count(),
        this.prisma.helmetBatch.count(),
        this.prisma.helmet.groupBy({
          by: ['status'],
          _count: { _all: true },
          orderBy: { status: 'asc' },
        }),
        this.prisma.helmet.count({ where: { activatedAt: { not: null } } }),
        this.prisma.helmetBatch.findMany({
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            batchCode: true,
            quantity: true,
            generatedCount: true,
            generationStatus: true,
            createdAt: true,
          },
        }),
      ]);
    const helmetsByStatus: Partial<Record<HelmetStatus, number>> = {};
    let helmets = 0;
    for (const row of byStatus) {
      const count = typeof row._count === 'object' && row._count ? (row._count._all ?? 0) : 0;
      helmetsByStatus[row.status] = count;
      helmets += count;
    }
    return {
      helmetModels,
      batches,
      helmets,
      activatedHelmets,
      helmetsByStatus,
      recentBatches: recent.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })),
    };
  }
}
