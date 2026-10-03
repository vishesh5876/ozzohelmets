import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Response } from 'express';
import type {
  ActivationAddHelmetResponse,
  ActivationRegisterResponse,
  ActivationValidateResponse,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import {
  CUSTOMER_REFRESH_COOKIE,
  CUSTOMER_REFRESH_COOKIE_PATH,
  type AuthenticatedCustomer,
} from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import { ActivationService } from './activation.service';
import { ActivationPinDto, RegisterActivationDto } from './dto/activation.dto';

@ApiTags('customer / activation')
@Controller('customer/activation')
@RateLimit('auth')
export class ActivationController {
  constructor(
    private readonly activation: ActivationService,
    private readonly config: AppConfigService,
  ) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Preliminary check: helmet eligible and PIN correct (nothing consumed). Strictly rate-limited; failures count towards lockouts.',
  })
  validate(
    @Body() dto: ActivationPinDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ActivationValidateResponse> {
    return this.activation.validate(dto, meta);
  }

  @Post('register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'First activation: PIN + new password → account, ownership, ACTIVATED (atomic). Returns a session and the recovery code (shown once).',
  })
  async register(
    @Body() dto: RegisterActivationDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ActivationRegisterResponse> {
    const { result, refresh } = await this.activation.register(dto, meta);
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'strict',
      path: CUSTOMER_REFRESH_COOKIE_PATH,
      domain: this.config.get('COOKIE_DOMAIN'),
    };
    res.cookie(CUSTOMER_REFRESH_COOKIE, refresh.token, { ...options, expires: refresh.expiresAt });
    return result;
  }

  @Post('add-helmet')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @ApiOperation({
    summary: 'Signed-in customer activates another helmet with its PIN (no new account).',
  })
  addHelmet(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ActivationPinDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ActivationAddHelmetResponse> {
    return this.activation.addHelmet(customer, dto, meta);
  }
}
