import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Response } from 'express';
import type {
  CustomerSafetyIdDetailDto,
  CustomerSafetyIdDto,
  SafetyIdTransferStartResponse,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { RecentAuthToken } from '../../common/http/recent-auth-token.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import {
  type AuthenticatedCustomer,
  CUSTOMER_REFRESH_COOKIE,
  CUSTOMER_REFRESH_COOKIE_PATH,
} from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import { EmergencyProfileService } from '../emergency/profile/emergency-profile.service';
import { LabelsService } from '../labels/labels.service';
import { CustomerSafetyIdsService } from './customer-safety-ids.service';
import { SafetyIdClaimDto, SafetyIdClaimRegisterDto } from './dto/safety-id.dto';
import { SafetyIdTransferService } from './safety-id-transfer.service';

/** "My Safety IDs": the customer's emergency QR identities, their sharing and transfers. */
@ApiTags('customer / safety IDs')
@Controller('customer/safety-ids')
@CustomerAuth()
export class CustomerSafetyIdsController {
  constructor(
    private readonly safetyIds: CustomerSafetyIdsService,
    private readonly profiles: EmergencyProfileService,
    private readonly transfers: SafetyIdTransferService,
    private readonly labels: LabelsService,
  ) {}

  @Get()
  list(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<CustomerSafetyIdDto[]> {
    return this.safetyIds.list(customer.id);
  }

  @Get(':id')
  detail(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerSafetyIdDetailDto> {
    return this.safetyIds.detail(customer.id, id);
  }

  @Get(':id/qr')
  @RawResponse()
  @ApiProduces('image/svg+xml')
  async qr(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { publicUrl } = await this.safetyIds.get(customer.id, id);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('image/svg+xml').send(await this.labels.qrSvg(publicUrl));
  }

  @Post(':id/emergency/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Show your emergency profile on this Safety ID (ACTIVATED → ACTIVE).' })
  async enable(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerSafetyIdDto> {
    await this.profiles.enableForSafetyId(customer, id, meta);
    return this.safetyIds.get(customer.id, id);
  }

  @Post(':id/emergency/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop showing your emergency profile on this Safety ID.' })
  async disable(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerSafetyIdDto> {
    await this.profiles.disableForSafetyId(customer, id, meta);
    return this.safetyIds.get(customer.id, id);
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiHeader({ name: 'X-Recent-Auth', required: true })
  @ApiOperation({
    summary:
      'Standalone Safety IDs only: single-use Transfer Code (shown once). Requires recent password confirmation.',
  })
  startTransfer(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @RecentAuthToken() recentAuth: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SafetyIdTransferStartResponse> {
    return this.transfers.create(customer, id, recentAuth, meta);
  }

  @Delete(':id/transfer')
  async cancelTransfer(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ cancelled: true }> {
    await this.transfers.cancel(customer, id, meta);
    return { cancelled: true };
  }
}

/** Recipient of a standalone Safety ID: claim with Safety ID + Transfer Code. */
@ApiTags('customer / safety IDs')
@Controller('customer/safety-id-transfers')
export class SafetyIdClaimController {
  constructor(
    private readonly transfers: SafetyIdTransferService,
    private readonly config: AppConfigService,
  ) {}

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @RateLimit('auth')
  claim(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: SafetyIdClaimDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ safetyId: CustomerSafetyIdDto }> {
    return this.transfers.claim(customer, dto.safetyCode, dto.transferCode, meta);
  }

  @Post('claim/register')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  async claimAsNewCustomer(
    @Body() dto: SafetyIdClaimRegisterDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { result, session } = await this.transfers.claimAsNewCustomer(
      dto.safetyCode,
      dto.transferCode,
      dto.email,
      dto.mobile,
      dto.password,
      dto.name,
      meta,
      dto.emailProof,
    );
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'strict',
      path: CUSTOMER_REFRESH_COOKIE_PATH,
      domain: this.config.get('COOKIE_DOMAIN'),
    };
    res.cookie(CUSTOMER_REFRESH_COOKIE, session.refresh.token, {
      ...options,
      expires: session.refresh.expiresAt,
    });
    return result;
  }
}
