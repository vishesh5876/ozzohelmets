import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { type BatchDto, Permission } from '@helmet/types';
import type { PaginatedResult } from '../../common/http/api-response.interceptor';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { ExportsService } from '../exports/exports.service';
import { BatchesService } from './batches.service';
import { BatchQueryDto, CreateBatchDto } from './dto/batch.dto';

@ApiTags('admin / batches')
@Controller('admin/batches')
export class BatchesController {
  constructor(
    private readonly batches: BatchesService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  @AdminAuth(Permission.BATCHES_READ)
  list(@Query() query: BatchQueryDto): Promise<PaginatedResult<BatchDto>> {
    return this.batches.list(query);
  }

  @Get(':id')
  @AdminAuth(Permission.BATCHES_READ)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<BatchDto> {
    return this.batches.get(id);
  }

  @Post()
  @AdminAuth(Permission.BATCHES_WRITE)
  create(
    @Body() dto: CreateBatchDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<BatchDto> {
    return this.batches.create(dto, admin, meta);
  }

  @Post(':id/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @AdminAuth(Permission.BATCHES_GENERATE)
  @ApiOperation({
    summary:
      'Start (or resume) helmet identity generation. Poll GET /admin/batches/:id for progress.',
  })
  @ApiAcceptedResponse({ description: 'Generation started' })
  generate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<BatchDto> {
    return this.batches.startGeneration(id, admin, meta);
  }

  @Post(':id/mark-printed')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.BATCHES_WRITE)
  @ApiOperation({
    summary: 'Confirm labels printed: helmets → PRINTED and PIN escrow permanently purged.',
  })
  markPrinted(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<BatchDto> {
    return this.batches.markPrinted(id, admin, meta);
  }

  @Get(':id/export/manufacturing.csv')
  @AdminAuth(Permission.EXPORT_MANUFACTURING)
  @RawResponse()
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Manufacturing CSV including activation PINs (while escrowed). Audited.',
  })
  exportCsv(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    return this.exports.streamManufacturingCsv(id, admin, meta, res);
  }
}
