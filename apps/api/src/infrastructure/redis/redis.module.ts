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
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: false,
        });
        client.on('error', (err: Error) => logger.error(`Redis error: ${err.message}`));
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
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}
