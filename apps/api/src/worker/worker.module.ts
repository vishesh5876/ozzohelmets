import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { LoggingModule } from '../infrastructure/logging/logging.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { RedisModule } from '../infrastructure/redis/redis.module';
import { AnalyticsCoreModule } from '../modules/analytics/analytics.module';
import { AuditCoreModule } from '../modules/audit/audit.module';
import { CustomerSecurityModule } from '../modules/customer-security/customer-security.module';
import { PublicEmergencyCacheModule } from '../modules/public-emergency-cache/public-emergency-cache.module';
import { SecurityModule } from '../security/security.module';
import { WorkerScheduler } from './worker.scheduler';

/**
 * Worker process: infrastructure + analytics services only. No controllers, no HTTP server, no
 * customer/admin business modules.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    PrismaModule,
    RedisModule,
    SecurityModule,
    AuditCoreModule,
    CustomerSecurityModule,
    PublicEmergencyCacheModule,
    AnalyticsCoreModule,
  ],
  providers: [WorkerScheduler],
  exports: [WorkerScheduler],
})
export class WorkerModule {}
