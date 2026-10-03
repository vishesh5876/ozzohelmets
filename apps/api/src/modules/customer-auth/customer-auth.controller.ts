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
  type CustomerRecoverResponse,
  type CustomerResetPasswordResponse,
  type CustomerSessionDto,
  ErrorCode,
  type RecentAuthResponse,
  type RecoveryCodeIssued,
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
import {
  ChangePasswordDto,
  ConfirmPasswordDto,
  CustomerLoginDto,
  RecoverDto,
  ResetPasswordDto,
  UpdateCustomerDto,
} from './dto/customer-auth.dto';

const CSRF_HEADER = 'x-requested-with';

@ApiTags('customer / auth')
@Controller('customer/auth')
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Sign in with any currently owned Helmet ID + password. Generic errors; escalating lockouts.',
  })
  async login(
    @Body() dto: CustomerLoginDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerLoginResponse> {
    const session = await this.auth.login(dto.helmetCode, dto.password, meta);
    this.setRefreshCookie(res, session.refresh);
    return session.response;
  }

  @Post('recover')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Account recovery step 1: Helmet ID + offline recovery code → single-use reset token.',
  })
  recover(@Body() dto: RecoverDto, @ReqMeta() meta: RequestMeta): Promise<CustomerRecoverResponse> {
    return this.auth.recover(dto.helmetCode, dto.recoveryCode, meta);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Account recovery step 2: new password. Revokes all sessions, rotates the recovery code (returned once), signs in.',
  })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerResetPasswordResponse> {
    const { session, recoveryCode } = await this.auth.resetPassword(
      dto.resetToken,
      dto.newPassword,
      meta,
    );
    this.setRefreshCookie(res, session.refresh);
    return { ...session.response, recoveryCode };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Change password (current password required). Other sessions are revoked.',
  })
  async changePassword(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ChangePasswordDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ changed: true }> {
    await this.auth.changePassword(customer, dto.currentPassword, dto.newPassword, meta);
    return { changed: true };
  }

  @Post('recovery-code')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Generate a new recovery code (password required). The previous code stops working. Shown once.',
  })
  rotateRecoveryCode(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ConfirmPasswordDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<RecoveryCodeIssued> {
    return this.auth.rotateRecoveryCode(customer, dto.password, meta);
  }

  @Post('reauthenticate')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'Confirm the password for sensitive actions → short-lived recent-auth token (send as X-Recent-Auth).',
  })
  reauthenticate(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ConfirmPasswordDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<RecentAuthResponse> {
    return this.auth.reauthenticate(customer, dto.password, meta);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // Runs on every page load; customers often share carrier-grade NAT IPs. The 256-bit token can't
  // be guessed, and rotation + reuse detection bound abuse, so the default policy applies.
  @RateLimit('default')
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
    return this.auth.updateProfile(customer.id, dto);
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
