import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';

@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<{ status: 'ok'; database: 'up'; redis: 'up' }> {
    const [db, cache] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
    ]);
    if (db.status === 'rejected' || cache.status === 'rejected') {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Dependency unavailable.',
        HttpStatus.SERVICE_UNAVAILABLE,
        {
          database: db.status === 'fulfilled' ? 'up' : 'down',
          redis: cache.status === 'fulfilled' ? 'up' : 'down',
        },
      );
    }
    return { status: 'ok', database: 'up', redis: 'up' };
  }
}
