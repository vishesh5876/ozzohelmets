import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CustomerHelmetDto } from '@helmet/types';
import { RecentAuthToken } from '../../common/http/recent-auth-token.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import { MarkDamagedDto, RetireHelmetDto } from './dto/lifecycle.dto';
import { HelmetLifecycleService } from './helmet-lifecycle.service';

const RECENT_AUTH = {
  name: 'X-Recent-Auth',
  required: true,
  description: 'From POST /customer/auth/reauthenticate',
};

/** Explicit owner lifecycle actions (no generic "set status" for customers). */
@ApiTags('customer / helmet lifecycle')
@Controller('customer/helmets')
@CustomerAuth()
export class CustomerLifecycleController {
  constructor(private readonly lifecycle: HelmetLifecycleService) {}

  @Post(':id/lost')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report lost. Ownership is kept; the public page shows a lost notice.' })
  lost(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.lifecycle.reportLost(c, id, meta);
  }

  @Post(':id/found')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a lost helmet as found; returns to its previous safe state.' })
  found(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.lifecycle.markFound(c, id, meta);
  }

  @Post(':id/stolen')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({ summary: 'Report stolen (recent password confirmation required).' })
  stolen(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.lifecycle.reportStolen(c, id, token, meta);
  }

  @Post(':id/recovered')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({ summary: 'Mark a stolen helmet as recovered (recent password confirmation).' })
  recovered(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.lifecycle.markRecovered(c, id, token, meta);
  }

  @Post(':id/damaged')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark damaged (optional reason/short note). Transfer is then blocked.' })
  damaged(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkDamagedDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.lifecycle.markDamaged(c, id, dto, meta);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({
    summary:
      'Retire the helmet permanently (type the Helmet ID; recent password confirmation). Only support can undo.',
  })
  deactivate(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RetireHelmetDto,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerHelmetDto> {
    return this.lifecycle.retire(c, id, dto.confirmHelmetCode, token, meta);
  }
}
