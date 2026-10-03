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
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { EmergencyContactDto } from '@helmet/types';
import { ReqMeta, type RequestMeta } from '../../../common/utils/request-context';
import type { AuthenticatedCustomer } from '../../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../../customer-auth/decorators/customer-auth.decorator';
import {
  CreateEmergencyContactDto,
  ReorderEmergencyContactsDto,
  UpdateEmergencyContactDto,
} from './emergency-contacts.dto';
import { EmergencyContactsService } from './emergency-contacts.service';

@ApiTags('customer / emergency contacts')
@Controller('customer/emergency-contacts')
@CustomerAuth()
export class EmergencyContactsController {
  constructor(private readonly contacts: EmergencyContactsService) {}

  @Get()
  list(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<EmergencyContactDto[]> {
    return this.contacts.list(customer.id);
  }

  @Post()
  create(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: CreateEmergencyContactDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyContactDto> {
    return this.contacts.create(customer, dto, meta);
  }

  @Put('order')
  reorder(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: ReorderEmergencyContactsDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyContactDto[]> {
    return this.contacts.reorder(customer, dto, meta);
  }

  @Patch(':id')
  update(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateEmergencyContactDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyContactDto> {
    return this.contacts.update(customer, id, dto, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ deleted: true }> {
    await this.contacts.remove(customer, id, meta);
    return { deleted: true };
  }
}
