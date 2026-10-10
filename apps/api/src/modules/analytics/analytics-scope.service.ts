import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * Which helmets count as real operational data. Internal acceptance-test helmets are identified
 * by their model SKU (ANALYTICS_EXCLUDED_MODEL_SKUS, default "OZZO-INTERNAL-TEST"), so no schema
 * change or per-helmet flag is needed: create test helmets under that model and they stay out of
 * the platform analytics headline numbers. They still work normally everywhere else.
 */
@Injectable()
export class AnalyticsScopeService {
  private cache: { ids: string[]; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Model ids whose helmets are excluded from analytics (cached for a minute). */
  async excludedModelIds(): Promise<string[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.ids;
    const skus = this.config.get('ANALYTICS_EXCLUDED_MODEL_SKUS');
    const ids = skus.length
      ? (
          await this.prisma.helmetModel.findMany({
            where: { sku: { in: skus, mode: 'insensitive' } },
            select: { id: true },
          })
        ).map((m) => m.id)
      : [];
    this.cache = { ids, at: Date.now() };
    return ids;
  }
}
