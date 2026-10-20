import {
  type ArgumentsHost,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  HttpException,
  Injectable,
  Logger,
  Param,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { getCountryCode } from '../../common/utils/client-ip';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import { AppConfigService } from '../../config/app-config.service';
import {
  EMERGENCY_PAGE_CSP,
  type EmergencyPageResult,
  renderEmergencyPage,
} from './page/emergency-page';
import { PublicEmergencyService } from './public-emergency.service';

function sendPage(res: Response, page: { status: number; html: string }): void {
  res.status(page.status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', EMERGENCY_PAGE_CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(page.html);
}

/**
 * Any failure on the page route — unknown token, abuse/rate limit (also from the route
 * throttler, before the handler runs), database trouble — still answers with an HTML page that
 * has the "Call emergency" button. Never a JSON error on a scanned QR.
 */
@Injectable()
@Catch()
export class EmergencyPageExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('EmergencyPage');

  constructor(private readonly config: AppConfigService) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const status = err instanceof HttpException ? err.getStatus() : 500;
    const kind: EmergencyPageResult['kind'] =
      status === 404 ? 'not-found' : status === 429 ? 'rate-limited' : 'error';
    if (kind === 'error') this.logger.error(`Emergency page failed: ${(err as Error).message}`);
    sendPage(
      ctx.getResponse<Response>(),
      renderEmergencyPage(
        { kind },
        {
          token: String(req.params?.token ?? ''),
          emergencyNumber: this.config.get('PUBLIC_EMERGENCY_NUMBER'),
        },
      ),
    );
  }
}

/**
 * GET /api/v1/public/emergency/:token/page — the public emergency page, server-rendered.
 * nginx serves it at /e/:token. Same lookup, cache, scan logging and abuse rules as the JSON
 * endpoint (PublicEmergencyService.resolve).
 */
@ApiExcludeController()
@Controller('public/emergency')
@RateLimit('public')
@UseFilters(EmergencyPageExceptionFilter)
export class PublicEmergencyPageController {
  constructor(
    private readonly service: PublicEmergencyService,
    private readonly config: AppConfigService,
  ) {}

  @Get(':token/page')
  @RawResponse()
  async page(
    @Param('token') token: string,
    @ReqMeta() meta: RequestMeta,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const data = await this.service.resolve(token, {
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      countryCode: getCountryCode(req, this.config.get('TRUST_CLOUDFLARE')),
    });
    sendPage(
      res,
      renderEmergencyPage(
        { kind: 'ok', data },
        { token, emergencyNumber: this.config.get('PUBLIC_EMERGENCY_NUMBER') },
      ),
    );
  }
}
