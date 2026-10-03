import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EmergencyVisibilityDto } from '@helmet/types';
import { ReqMeta, type RequestMeta } from '../../../common/utils/request-context';
import type { AuthenticatedCustomer } from '../../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../../customer-auth/decorators/customer-auth.decorator';
import { UpdateEmergencyVisibilityDto } from './emergency-visibility.dto';
import { EmergencyVisibilityService } from './emergency-visibility.service';

@ApiTags('customer / emergency visibility')
@Controller('customer/emergency-visibility')
@CustomerAuth()
export class EmergencyVisibilityController {
  constructor(private readonly visibility: EmergencyVisibilityService) {}

  @Get()
  get(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<EmergencyVisibilityDto> {
    return this.visibility.get(customer.id);
  }

  @Put()
  @ApiOperation({
    summary:
      'Replace public visibility choices (all default to hidden). Counts as the privacy review.',
  })
  update(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: UpdateEmergencyVisibilityDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyVisibilityDto> {
    return this.visibility.update(customer, dto, meta);
  }
}
