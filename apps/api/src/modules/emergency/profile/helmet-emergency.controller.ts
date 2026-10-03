import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReqMeta, type RequestMeta } from '../../../common/utils/request-context';
import type { AuthenticatedCustomer } from '../../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../../customer-auth/decorators/customer-auth.decorator';
import { EmergencyProfileService } from './emergency-profile.service';

/** Per-helmet emergency exposure: the profile belongs to the customer, the switch to each helmet. */
@ApiTags('customer / helmets')
@Controller('customer/helmets')
@CustomerAuth()
export class HelmetEmergencyController {
  constructor(private readonly profiles: EmergencyProfileService) {}

  @Post(':id/emergency/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Show your emergency profile on this helmet (ACTIVATED → ACTIVE).' })
  async enable(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ enabled: true }> {
    await this.profiles.enableForHelmet(customer, id, meta);
    return { enabled: true };
  }

  @Post(':id/emergency/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop showing your emergency profile on this helmet.' })
  async disable(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ enabled: false }> {
    await this.profiles.disableForHelmet(customer, id, meta);
    return { enabled: false };
  }
}
