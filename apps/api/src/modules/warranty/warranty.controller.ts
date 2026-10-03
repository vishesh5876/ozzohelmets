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
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  type AdminWarrantyDetailDto,
  type AdminWarrantyListItemDto,
  type CustomerWarrantyDto,
  Permission,
} from '@helmet/types';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { RecentAuthToken } from '../../common/http/recent-auth-token.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import type { StoredFile } from '../file-storage/file-storage.types';
import {
  CorrectWarrantyDto,
  RegisterWarrantyDto,
  RestoreWarrantyDto,
  VoidWarrantyDto,
  WarrantyQueryDto,
} from './dto/warranty.dto';
import { WarrantyAdminService } from './warranty-admin.service';
import { WarrantyService } from './warranty.service';

const UPLOAD_HARD_LIMIT = 26 * 1024 * 1024;

/** Private documents are only ever downloaded — never rendered inline by the browser. */
function sendDocument(res: Response, file: StoredFile, name: string): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const ext = file.contentType === 'application/pdf' ? 'pdf' : 'webp';
  res.setHeader('Content-Disposition', `attachment; filename="${name}.${ext}"`);
  res.type(file.contentType).send(file.buffer);
}

@ApiTags('customer / warranty')
@Controller('customer/helmets/:id/warranty')
@CustomerAuth()
export class CustomerWarrantyController {
  constructor(private readonly warranties: WarrantyService) {}

  @Get()
  get(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerWarrantyDto> {
    return this.warranties.forCustomer(c, id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register the warranty. Dates are computed by the server from the model policy.',
  })
  register(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RegisterWarrantyDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerWarrantyDto> {
    return this.warranties.register(c, id, dto, meta);
  }

  @Post('proof')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('proof', { limits: { fileSize: UPLOAD_HARD_LIMIT, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { proof: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({ summary: 'Upload proof of purchase (JPEG/PNG/WebP/PDF, ≤ 10 MB). Private.' })
  uploadProof(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerWarrantyDto> {
    return this.warranties.uploadProof(c, id, file?.buffer, meta);
  }

  @Delete('proof')
  removeProof(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CustomerWarrantyDto> {
    return this.warranties.removeProof(c, id, meta);
  }

  @Get('proof')
  @RawResponse()
  async proof(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendDocument(res, await this.warranties.proofForCustomer(c, id), 'proof-of-purchase');
  }
}

@ApiTags('admin / warranty')
@Controller('admin/warranties')
export class AdminWarrantyController {
  constructor(private readonly admin: WarrantyAdminService) {}

  @Get()
  @AdminAuth(Permission.WARRANTY_VIEW)
  list(@Query() q: WarrantyQueryDto): Promise<PaginatedResult<AdminWarrantyListItemDto>> {
    return this.admin.list(q);
  }

  @Get(':id')
  @AdminAuth(Permission.WARRANTY_VIEW)
  detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminWarrantyDetailDto> {
    return this.admin.detail(id);
  }

  @Patch(':id')
  @AdminAuth(Permission.WARRANTY_MANAGE)
  @ApiOperation({ summary: 'Correct dates/purchase fields with a reason (history + audit).' })
  correct(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CorrectWarrantyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminWarrantyDetailDto> {
    return this.admin.correct(admin, id, dto, meta);
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.WARRANTY_VOID)
  @ApiHeader({ name: 'X-Recent-Auth', required: true })
  void(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: VoidWarrantyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminWarrantyDetailDto> {
    return this.admin.voidWarranty(admin, id, dto.reason, dto.note, token, meta);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.WARRANTY_VOID)
  restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RestoreWarrantyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminWarrantyDetailDto> {
    return this.admin.restore(admin, id, dto.note, meta);
  }

  @Get(':id/proof')
  @AdminAuth(Permission.WARRANTY_DOCUMENT_VIEW)
  @RawResponse()
  @ApiOperation({ summary: 'Download the private proof of purchase (audited).' })
  async proof(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    sendDocument(res, await this.admin.proof(admin, id, meta), 'proof-of-purchase');
  }
}
