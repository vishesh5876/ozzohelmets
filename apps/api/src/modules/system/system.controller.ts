import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Header, Headers, HttpStatus } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ErrorCode, Permission, type SystemStatusDto } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { AppConfigService } from '../../config/app-config.service';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { SystemStatusService } from './system-status.service';

@ApiTags('admin / system')
@Controller('admin/system')
export class AdminSystemController {
  constructor(private readonly system: SystemStatusService) {}

  @Get('status')
  @AdminAuth(Permission.DASHBOARD_READ)
  @ApiOperation({ summary: 'API version, worker heartbeat, job freshness, dependency state.' })
  status(): Promise<SystemStatusDto> {
    return this.system.status();
  }
}

/**
 * Prometheus scrape endpoint for the private network. Requires `Authorization: Bearer
 * <METRICS_TOKEN>`; disabled (404) when no token is configured. The edge proxy also refuses
 * `/api/v1/internal/` from the internet.
 */
@Controller('internal')
@SkipThrottle()
export class InternalMetricsController {
  constructor(
    private readonly system: SystemStatusService,
    private readonly config: AppConfigService,
  ) {}

  @Get('metrics')
  @ApiExcludeEndpoint()
  @RawResponse()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  metrics(@Headers('authorization') auth?: string): Promise<string> {
    const token = this.config.get('METRICS_TOKEN');
    if (!token) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Not found.');
    const given = Buffer.from(auth?.replace(/^Bearer\s+/i, '') ?? '');
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new AppException(ErrorCode.UNAUTHORIZED, 'Unauthorized.', HttpStatus.UNAUTHORIZED);
    return this.system.prometheus();
  }
}
