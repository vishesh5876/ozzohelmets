import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { PublicEmergencyDto } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { getCountryCode } from '../../common/utils/client-ip';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import { PublicEmergencyService } from './public-emergency.service';

@ApiTags('public')
@Controller('public/emergency')
@RateLimit('public')
export class PublicEmergencyController {
  constructor(
    private readonly service: PublicEmergencyService,
    private readonly config: AppConfigService,
  ) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({
    summary: 'Resolve a helmet QR token. No authentication. Returns only public-safe data.',
  })
  @ApiOkResponse({ description: 'Public helmet state' })
  resolve(
    @Param('token') token: string,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
  ): Promise<PublicEmergencyDto> {
    return this.service.resolve(token, {
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      countryCode: getCountryCode(req, this.config.get('TRUST_CLOUDFLARE')),
    });
  }
}
