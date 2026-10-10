import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';

type Dep = 'up' | 'down';
export interface ReadinessDto {
  status: 'ok' | 'degraded';
  database: Dep;
  redis: Dep;
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

/**
 * Liveness = the process answers. Readiness = it can serve traffic: PostgreSQL is required;
 * Redis is reported but optional (public emergency pages fall back to PostgreSQL, auth paths
 * answer 503 on their own). Never returns configuration values or connection details.
 */
@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is running (no dependency checks).' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: 503 when PostgreSQL is down; "degraded" when only Redis is.',
  })
  ready(): Promise<ReadinessDto> {
    return this.readiness();
  }

  /** Backwards-compatible alias of /health/ready. */
  @Get()
  check(): Promise<ReadinessDto> {
    return this.readiness();
  }

  private async readiness(): Promise<ReadinessDto> {
    const [db, cache] = await Promise.allSettled([
      withTimeout(this.prisma.$queryRaw`SELECT 1`, 3_000),
      withTimeout(this.redis.ping(), 1_500),
    ]);
    const database: Dep = db.status === 'fulfilled' ? 'up' : 'down';
    const redis: Dep = cache.status === 'fulfilled' ? 'up' : 'down';
    if (database === 'down')
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Dependency unavailable.',
        HttpStatus.SERVICE_UNAVAILABLE,
        { database, redis },
      );
    return { status: redis === 'up' ? 'ok' : 'degraded', database, redis };
  }
}
