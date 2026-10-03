import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { type HelmetDetailDto, type HelmetListItemDto, Permission } from '@helmet/types';
import type { PaginatedResult } from '../../common/http/api-response.interceptor';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { LabelsService } from '../labels/labels.service';
import { ChangeHelmetStatusDto, HelmetQueryDto } from './dto/helmet.dto';
import { HelmetsService } from './helmets.service';

type ImageFormat = 'svg' | 'png';
const parseFormat = (value: string | undefined): ImageFormat => (value === 'png' ? 'png' : 'svg');

@ApiTags('admin / helmets')
@Controller('admin/helmets')
export class HelmetsController {
  constructor(
    private readonly helmets: HelmetsService,
    private readonly labels: LabelsService,
  ) {}

  @Get()
  @AdminAuth(Permission.HELMETS_READ)
  list(@Query() query: HelmetQueryDto): Promise<PaginatedResult<HelmetListItemDto>> {
    return this.helmets.list(query);
  }

  @Get(':id')
  @AdminAuth(Permission.HELMETS_READ)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<HelmetDetailDto> {
    return this.helmets.get(id);
  }

  @Patch(':id/status')
  @AdminAuth(Permission.HELMETS_UPDATE_STATUS)
  @ApiOperation({ summary: 'Change lifecycle status (validated against the transition table).' })
  changeStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeHelmetStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<HelmetDetailDto> {
    return this.helmets.changeStatus(id, dto.status, dto.reason, admin, meta);
  }

  @Get(':id/qr')
  @AdminAuth(Permission.LABELS_READ)
  @RawResponse()
  @ApiQuery({ name: 'format', enum: ['svg', 'png'], required: false })
  @ApiProduces('image/svg+xml', 'image/png')
  async qr(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const helmet = await this.helmets.get(id);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (parseFormat(format) === 'png') {
      res.type('image/png').send(await this.labels.qrPng(helmet.qrUrl));
    } else {
      res.type('image/svg+xml').send(await this.labels.qrSvg(helmet.qrUrl));
    }
  }

  @Get(':id/barcode')
  @AdminAuth(Permission.LABELS_READ)
  @RawResponse()
  @ApiQuery({ name: 'format', enum: ['svg', 'png'], required: false })
  @ApiProduces('image/svg+xml', 'image/png')
  async barcode(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const helmet = await this.helmets.get(id);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (parseFormat(format) === 'png') {
      res.type('image/png').send(await this.labels.barcodePng(helmet.helmetCode));
    } else {
      res.type('image/svg+xml').send(this.labels.barcodeSvg(helmet.helmetCode));
    }
  }
}
