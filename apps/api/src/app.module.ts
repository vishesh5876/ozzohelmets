import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { ApiResponseInterceptor } from './common/http/api-response.interceptor';
import { RequestMetaMiddleware } from './common/utils/request-meta.middleware';
import { AppConfigModule } from './config/config.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AdminUsersModule } from './modules/admin-users/admin-users.module';
import { AuditModule } from './modules/audit/audit.module';
import { CustomerAuthModule } from './modules/customer-auth/customer-auth.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BatchesModule } from './modules/batches/batches.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { HelmetModelsModule } from './modules/helmet-models/helmet-models.module';
import { HelmetsModule } from './modules/helmets/helmets.module';
import { PublicEmergencyModule } from './modules/public-emergency/public-emergency.module';
import { SecurityModule } from './security/security.module';

@Module({
  imports: [
    // Infrastructure
    AppConfigModule,
    LoggingModule,
    PrismaModule,
    RedisModule,
    SecurityModule,
    RateLimitModule,
    // Cross-cutting domain
    AuditModule,
    AdminAuthModule,
    NotificationsModule,
    CustomerAuthModule,
    // Features
    HealthModule,
    AdminUsersModule,
    DashboardModule,
    HelmetModelsModule,
    BatchesModule,
    HelmetsModule,
    PublicEmergencyModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestMetaMiddleware).forRoutes('*');
  }
}
