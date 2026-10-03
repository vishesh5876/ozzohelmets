import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  type EmergencyProfileDto,
  type EmergencyReadinessDto,
  ErrorCode,
  type PublicEmergencyDto,
} from '@helmet/types';
import { AppException } from '../../../common/http/app.exception';
import { RawResponse } from '../../../common/http/raw-response.decorator';
import { ReqMeta, type RequestMeta } from '../../../common/utils/request-context';
import type { AuthenticatedCustomer } from '../../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../../customer-auth/decorators/customer-auth.decorator';
import { UpdateEmergencyProfileDto } from './emergency-profile.dto';
import { EmergencyProfileService } from './emergency-profile.service';

/** Hard upload cap enforced while streaming; the configured photo limit is checked afterwards. */
const UPLOAD_HARD_LIMIT = 20 * 1024 * 1024;

@ApiTags('customer / emergency profile')
@Controller('customer/emergency-profile')
@CustomerAuth()
export class EmergencyProfileController {
  constructor(private readonly profiles: EmergencyProfileService) {}

  @Get()
  get(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<EmergencyProfileDto> {
    return this.profiles.get(customer.id);
  }

  @Put()
  @ApiOperation({
    summary:
      'Create or update the emergency profile (partial; null clears). Medical fields are encrypted at rest.',
  })
  update(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: UpdateEmergencyProfileDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyProfileDto> {
    return this.profiles.update(customer, dto, meta);
  }

  @Get('readiness')
  @ApiOperation({
    summary: 'What is still required before the profile can be enabled, plus UX progress.',
  })
  readiness(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<EmergencyReadinessDto> {
    return this.profiles.readinessFor(customer.id);
  }

  @Get('preview')
  @ApiOperation({
    summary: 'Exactly what an anonymous QR scan would show with the current visibility settings.',
  })
  preview(
    @CurrentCustomer() customer: AuthenticatedCustomer,
  ): Promise<Pick<PublicEmergencyDto, 'profile' | 'contacts'>> {
    return this.profiles.preview(customer.id);
  }

  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable the emergency profile; owned ACTIVATED helmets become ACTIVE.' })
  enable(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyReadinessDto> {
    return this.profiles.enable(customer, meta);
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disable the emergency profile; public pages stop showing it immediately.',
  })
  disable(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyReadinessDto> {
    return this.profiles.disable(customer, meta);
  }

  @Put('photo')
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: UPLOAD_HARD_LIMIT, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { photo: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: 'Upload a JPEG/PNG/WebP photo. Re-encoded server-side; metadata (incl. GPS) removed.',
  })
  setPhoto(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyProfileDto> {
    return this.profiles.setPhoto(customer, file?.buffer, meta);
  }

  @Delete('photo')
  deletePhoto(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EmergencyProfileDto> {
    return this.profiles.deletePhoto(customer, meta);
  }

  @Get('photo')
  @RawResponse()
  async photo(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.profiles.photo(customer.id);
    if (!file) throw AppException.notFound(ErrorCode.NOT_FOUND, 'No photo uploaded.');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(file.contentType).send(file.buffer);
  }
}
