import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type DashboardStatsDto, type HelmetStatus, Permission } from '@helmet/types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';

@ApiTags('admin / dashboard')
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

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
