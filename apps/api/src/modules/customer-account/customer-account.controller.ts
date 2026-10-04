import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type {
  AccountDeletionRequestDto,
  CustomerSecurityEventDto,
  CustomerSecurityStatusDto,
} from '@helmet/types';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { RecentAuthToken } from '../../common/http/recent-auth-token.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import { CustomerAccountService } from './customer-account.service';
import { DeletionRequestDto } from './dto/customer-account.dto';

const RECENT_AUTH = {
  name: 'X-Recent-Auth',
  required: true,
  description: 'From POST /customer/auth/reauthenticate',
};

@ApiTags('customer-account')
@Controller('customer/account')
@CustomerAuth()
export class CustomerAccountController {
  constructor(private readonly account: CustomerAccountService) {}

  @Get('security')
  @ApiOperation({ summary: 'Recovery-code status, sessions count, password age (no secrets).' })
  security(@CurrentCustomer() c: AuthenticatedCustomer): Promise<CustomerSecurityStatusDto> {
    return this.account.securityStatus(c.id);
  }

  @Get('activity')
  @ApiOperation({
    summary: 'Your recent security activity (no IP addresses, device summary only).',
  })
  activity(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<CustomerSecurityEventDto[]> {
    return this.account.activity(c.id, limit);
  }

  @Get('export')
  @RawResponse()
  @RateLimit('auth')
  @ApiHeader(RECENT_AUTH)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Download your data as JSON (recent password confirmation required). No hashes, tokens or other people’s data.',
  })
  async export(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    const data = await this.account.exportData(c, token, meta);
    const name = `helmet-account-${data.account.customerId}-${data.exportedAt.slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('application/json').send(JSON.stringify(data, null, 2));
  }

  @Get('deletion-request')
  @ApiOperation({ summary: 'Your most recent account deletion request (or null).' })
  deletionRequest(
    @CurrentCustomer() c: AuthenticatedCustomer,
  ): Promise<AccountDeletionRequestDto | null> {
    return this.account.deletionRequest(c.id);
  }

  @Post('deletion-request')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('auth')
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({
    summary:
      'Request account deletion (recent password confirmation). Reviewed by support; nothing is erased automatically.',
  })
  requestDeletion(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Body() dto: DeletionRequestDto,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AccountDeletionRequestDto> {
    return this.account.requestDeletion(c, dto.reason, token, meta);
  }

  @Delete('deletion-request')
  @ApiOperation({ summary: 'Cancel your open deletion request (before it is completed).' })
  cancelDeletion(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AccountDeletionRequestDto> {
    return this.account.cancelDeletion(c, meta);
  }
}
