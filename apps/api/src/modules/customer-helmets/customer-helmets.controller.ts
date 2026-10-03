import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { CustomerDashboardDto, CustomerHelmetDto } from '@helmet/types';
import { RawResponse } from '../../common/http/raw-response.decorator';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import { LabelsService } from '../labels/labels.service';
import { CustomerHelmetsService } from './customer-helmets.service';

@ApiTags('customer / helmets')
@Controller('customer')
@CustomerAuth()
export class CustomerHelmetsController {
  constructor(
    private readonly helmets: CustomerHelmetsService,
    private readonly labels: LabelsService,
  ) {}

  @Get('dashboard')
  dashboard(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<CustomerDashboardDto> {
    return this.helmets.dashboard(customer.id);
  }

  @Get('helmets')
  list(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<CustomerHelmetDto[]> {
    return this.helmets.list(customer.id);
  }

  @Get('helmets/:id')
  get(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerHelmetDto> {
    return this.helmets.get(customer.id, id);
  }

  @Get('helmets/:id/qr')
  @RawResponse()
  @ApiProduces('image/svg+xml')
  async qr(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.helmets.publicUrl(customer.id, id);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('image/svg+xml').send(await this.labels.qrSvg(url));
  }
}
