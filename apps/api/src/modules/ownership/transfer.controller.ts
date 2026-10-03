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
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Response } from 'express';
import type {
  PendingTransferDto,
  TransferClaimPreviewResponse,
  TransferClaimRegisterResponse,
  TransferClaimResponse,
  TransferCreatedResponse,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
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
import { TransferClaimDto, TransferClaimRegisterDto } from './dto/transfer.dto';
import { TransferService } from './transfer.service';

/** Current owner: create, inspect and cancel a transfer offer. */
@ApiTags('customer / transfer')
@Controller('customer/helmets')
@CustomerAuth()
export class OwnerTransferController {
  constructor(private readonly transfers: TransferService) {}

  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiHeader({
    name: 'X-Recent-Auth',
    required: true,
    description: 'From /customer/auth/reauthenticate',
  })
  @ApiOperation({
    summary:
      'Generate a single-use transfer code (shown once). Replaces any previous code. Requires recent password confirmation.',
  })
  create(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @RecentAuthToken() recentAuth: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<TransferCreatedResponse> {
    return this.transfers.create(customer, id, recentAuth, meta);
  }

  @Get(':id/transfer')
  pending(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PendingTransferDto> {
    return this.transfers.pending(customer, id);
  }

  @Delete(':id/transfer')
  @ApiOperation({ summary: 'Cancel the pending transfer; the code stops working immediately.' })
  async cancel(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ cancelled: true }> {
    await this.transfers.cancel(customer, id, meta);
    return { cancelled: true };
  }
}

/** Recipient: preview and claim with Helmet ID + transfer code. */
@ApiTags('customer / transfer')
@Controller('customer/transfers')
export class TransferClaimController {
  constructor(
    private readonly transfers: TransferService,
    private readonly config: AppConfigService,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({ summary: 'Check Helmet ID + transfer code (nothing is changed).' })
  preview(
    @Body() dto: TransferClaimDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<TransferClaimPreviewResponse> {
    return this.transfers.preview(dto.helmetCode, dto.transferCode, meta);
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @RateLimit('auth')
  @ApiOperation({ summary: 'Signed-in customer claims the helmet (atomic ownership change).' })
  claim(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: TransferClaimDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<TransferClaimResponse> {
    return this.transfers.claim(customer, dto.helmetCode, dto.transferCode, meta);
  }

  @Post('claim/register')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @ApiOperation({
    summary:
      'New customer claims the helmet: account + ownership in one transaction; returns a session and the recovery code (shown once).',
  })
  async claimAsNewCustomer(
    @Body() dto: TransferClaimRegisterDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransferClaimRegisterResponse> {
    const { result, session } = await this.transfers.claimAsNewCustomer(
      dto.helmetCode,
      dto.transferCode,
      dto.password,
      dto.name,
      meta,
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
