import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import {
  type CustomerLoginResponse,
  type CustomerProfile,
  type CustomerSessionDto,
  ErrorCode,
  type OtpRequestResponse,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { IssuedRefreshToken } from '../../security/refresh-token-rotator';
import { CustomerAuthService } from './customer-auth.service';
import {
  type AuthenticatedCustomer,
  CUSTOMER_REFRESH_COOKIE,
  CUSTOMER_REFRESH_COOKIE_PATH,
} from './customer-auth.types';
import { CurrentCustomer } from './decorators/current-customer.decorator';
import { CustomerAuth } from './decorators/customer-auth.decorator';
import { OtpRequestDto, OtpVerifyDto, UpdateCustomerDto } from './dto/customer-auth.dto';

const CSRF_HEADER = 'x-requested-with';

@ApiTags('customer / auth')
@Controller('customer/auth')
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Send a one-time code to a mobile number. Same response whether or not an account exists.',
  })
  requestOtp(
    @Body() dto: OtpRequestDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OtpRequestResponse> {
    return this.auth.requestOtp(dto.mobile, meta);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Verify the code; signs in (creating the account on first use) and sets the refresh cookie.',
  })
  async verifyOtp(
    @Body() dto: OtpVerifyDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerLoginResponse> {
    const session = await this.auth.verifyOtp(dto.mobile, dto.otp, meta);
    this.setRefreshCookie(res, session.refresh);
    return session.response;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiHeader({
    name: 'X-Requested-With',
    required: true,
    description: 'CSRF defence; any non-empty value',
  })
  async refresh(
    @Req() req: Request,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerLoginResponse> {
    this.assertCsrfHeader(req);
    const token = this.readRefreshCookie(req);
    if (!token)
      throw AppException.unauthorized(ErrorCode.REFRESH_TOKEN_INVALID, 'No active session.');
    try {
      const session = await this.auth.refresh(token, meta);
      this.setRefreshCookie(res, session.refresh);
      return session.response;
    } catch (err) {
      this.clearRefreshCookie(res);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'X-Requested-With', required: true })
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

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @ApiOperation({ summary: 'Revoke every session of the current customer (all devices).' })
  async logoutAll(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    await this.auth.logoutAll(customer, meta);
    this.clearRefreshCookie(res);
    return { loggedOut: true };
  }

  @Get('me')
  @CustomerAuth()
  me(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<CustomerProfile> {
    return this.auth.profile(customer.id);
  }

  @Patch('me')
  @CustomerAuth()
  updateMe(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: UpdateCustomerDto,
  ): Promise<CustomerProfile> {
    return this.auth.updateProfile(customer.id, dto.name);
  }

  @Get('sessions')
  @CustomerAuth()
  sessions(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<CustomerSessionDto[]> {
    return this.auth.sessions(customer);
  }

  @Delete('sessions/:id')
  @CustomerAuth()
  async revokeSession(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ revoked: true }> {
    await this.auth.revokeSession(customer, id, meta);
    return { revoked: true };
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'strict',
      path: CUSTOMER_REFRESH_COOKIE_PATH,
      domain: this.config.get('COOKIE_DOMAIN'),
    };
  }

  private setRefreshCookie(res: Response, refresh: IssuedRefreshToken): void {
    res.cookie(CUSTOMER_REFRESH_COOKIE, refresh.token, {
      ...this.cookieOptions(),
      expires: refresh.expiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(CUSTOMER_REFRESH_COOKIE, this.cookieOptions());
  }

  private readRefreshCookie(req: Request): string | undefined {
    return (req.cookies as Record<string, string | undefined> | undefined)?.[
      CUSTOMER_REFRESH_COOKIE
    ];
  }

  private assertCsrfHeader(req: Request): void {
    if (!req.headers[CSRF_HEADER]) throw AppException.forbidden('Missing CSRF header.');
  }
}
