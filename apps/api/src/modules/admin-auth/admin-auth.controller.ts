import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import type { CookieOptions, Request, Response } from 'express';
import { type AdminLoginResponse, type AdminProfile, ErrorCode } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import { AdminAuthService } from './admin-auth.service';
import {
  ADMIN_REFRESH_COOKIE,
  ADMIN_REFRESH_COOKIE_PATH,
  type AuthenticatedAdmin,
} from './admin-auth.types';
import { AdminAuth } from './decorators/admin-auth.decorator';
import { CurrentAdmin } from './decorators/current-admin.decorator';
import { AdminLoginDto } from './dto/login.dto';
import type { IssuedRefreshToken } from './admin-token.service';

const CSRF_HEADER = 'x-requested-with';

@ApiTags('admin / auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Admin login. Returns an access token; sets the refresh token as an httpOnly cookie.',
  })
  async login(
    @Body() dto: AdminLoginDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminLoginResponse> {
    const result = await this.auth.login(dto.email, dto.password, meta);
    this.setRefreshCookie(res, result.refresh);
    return result.response;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiHeader({
    name: 'X-Requested-With',
    required: true,
    description: 'CSRF defence; any non-empty value',
  })
  @ApiOperation({ summary: 'Rotate the refresh token cookie and issue a new access token.' })
  async refresh(
    @Req() req: Request,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminLoginResponse> {
    this.assertCsrfHeader(req);
    const token = this.readRefreshCookie(req);
    if (!token)
      throw AppException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID, 'No active session.');
    try {
      const result = await this.auth.refresh(token, meta);
      this.setRefreshCookie(res, result.refresh);
      return result.response;
    } catch (err) {
      this.clearRefreshCookie(res);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'X-Requested-With', required: true })
  @ApiOperation({ summary: 'Revoke the current refresh-token family and clear the cookie.' })
  async logout(
    @Req() req: Request,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    this.assertCsrfHeader(req);
    await this.auth.logout(this.readRefreshCookie(req), meta);
    this.clearRefreshCookie(res);
    return { loggedOut: true };
  }

  @Get('me')
  @AdminAuth()
  @ApiOperation({ summary: 'Current admin profile and effective permissions.' })
  me(@CurrentAdmin() admin: AuthenticatedAdmin): Promise<AdminProfile> {
    return this.auth.profile(admin.id);
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'strict',
      path: ADMIN_REFRESH_COOKIE_PATH,
      domain: this.config.get('COOKIE_DOMAIN'),
    };
  }

  private setRefreshCookie(res: Response, refresh: IssuedRefreshToken): void {
    res.cookie(ADMIN_REFRESH_COOKIE, refresh.token, {
      ...this.cookieOptions(),
      expires: refresh.expiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(ADMIN_REFRESH_COOKIE, this.cookieOptions());
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    return cookies?.[ADMIN_REFRESH_COOKIE];
  }

  /** A custom header cannot be sent cross-site without a CORS preflight that our allow-list rejects. */
  private assertCsrfHeader(req: Request): void {
    if (!req.headers[CSRF_HEADER]) throw AppException.forbidden('Missing CSRF header.');
  }
}
