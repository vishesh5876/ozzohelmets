import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';
import { REDIS_CLIENT } from './redis.constants';
import { RedisCacheService } from './redis-cache.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Redis => {
        const logger = new Logger('Redis');
        const client = new Redis(config.get('REDIS_URL'), {
          keyPrefix: config.get('REDIS_KEY_PREFIX'),
          // Fail fast when Redis is down: public paths fall back to PostgreSQL, security paths
          // answer 503 (see redis-errors.ts) instead of hanging requests on reconnects.
          // No offline queue: while disconnected, commands reject immediately instead of waiting
          // for reconnect back-off (which grows to seconds) — an outage must not slow the
          // emergency page. Reconnection itself continues in the background.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 2,
          connectTimeout: 2_000,
          commandTimeout: 2_000,
          enableReadyCheck: true,
          lazyConnect: false,
        });
        // Reconnect attempts emit an error each time; log at most every 30 s during an outage.
        let lastErrorLog = 0;
        client.on('error', (err: Error) => {
          if (Date.now() - lastErrorLog < 30_000) return;
          lastErrorLog = Date.now();
          logger.error(`Redis error: ${err.message}`);
        });
        client.on('ready', () => logger.log('Connected to Redis'));
        return client;
      },
    },
    RedisCacheService,
  ],
  exports: [REDIS_CLIENT, RedisCacheService],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    // quit() needs a live connection; otherwise disconnect() also stops the reconnect loop.
    if (this.redis.status === 'ready') await this.redis.quit().catch(() => this.redis.disconnect());
    else this.redis.disconnect();
  }
}
