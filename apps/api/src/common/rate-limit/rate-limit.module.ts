import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, type ThrottlerOptions } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { RedisThrottlerStorage } from '../../security/redis-throttler.storage';
import { AppThrottlerGuard } from './app-throttler.guard';
import { type RateLimitPolicy, resolvePolicy } from './rate-limit.decorator';

const onlyFor =
  (policy: RateLimitPolicy) =>
  (ctx: ExecutionContext): boolean =>
    resolvePolicy(ctx.getHandler(), ctx.getClass()) !== policy;

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, RedisThrottlerStorage],
      useFactory: (config: AppConfigService, storage: RedisThrottlerStorage) => {
        const ttl = config.get('THROTTLE_WINDOW_SECONDS') * 1000;
        const throttlers: ThrottlerOptions[] = [
          {
            name: 'default',
            ttl,
            limit: config.get('THROTTLE_DEFAULT_LIMIT'),
            skipIf: onlyFor('default'),
          },
          // Exceeding the auth limit blocks the client for 5 windows.
          {
            name: 'auth',
            ttl,
            limit: config.get('THROTTLE_AUTH_LIMIT'),
            blockDuration: ttl * 5,
            skipIf: onlyFor('auth'),
          },
          {
            name: 'public',
            ttl,
            limit: config.get('THROTTLE_PUBLIC_LIMIT'),
            skipIf: onlyFor('public'),
          },
        ];
        return { throttlers, storage, errorMessage: 'Too many requests.' };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class RateLimitModule {}
