import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ActivationResultDto, ActivationValidateResponse } from '@helmet/types';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import { ActivationService } from './activation.service';
import { ActivationTargetDto, CompleteActivationDto } from './dto/activation.dto';

@ApiTags('customer / activation')
@Controller('customer/activation')
@RateLimit('auth')
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a helmet can be activated (no auth, no PIN check, no ownership disclosure).',
  })
  validate(
    @Body() dto: ActivationTargetDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ActivationValidateResponse> {
    return this.activation.validate(dto, meta);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @CustomerAuth()
  @ApiOperation({
    summary: 'Activate a helmet with its PIN for the signed-in customer (atomic, row-locked).',
  })
  complete(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: CompleteActivationDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ActivationResultDto> {
    return this.activation.complete(customer, dto, meta);
  }
}
