import {
  Body,
  Controller,
  Delete,
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
import {
  type AdminSafetyIdDetailDto,
  type AdminSafetyIdListItemDto,
  Permission,
  roleHasPermission,
  type SafetyIdBatchDto,
} from '@helmet/types';
import type { PaginatedResult } from '../../common/http/api-response.interceptor';
import { RawResponse } from '../../common/http/raw-response.decorator';
import { RecentAuthToken } from '../../common/http/recent-auth-token.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { ExportsService } from '../exports/exports.service';
import { LabelsService } from '../labels/labels.service';
import { AdminSafetyIdsService } from './admin-safety-ids.service';
import {
  AdminSafetyIdQueryDto,
  CreateSafetyIdBatchDto,
  RevokeSafetyIdDto,
  SafetyIdBatchQueryDto,
  SafetyIdIntegrityDto,
  SafetyIdLinkDto,
  SafetyIdReasonDto,
} from './dto/safety-id.dto';
import { SafetyIdBatchesService } from './safety-id-batches.service';
import { SafetyIdTransferService } from './safety-id-transfer.service';

@ApiTags('admin / safety IDs')
@Controller('admin/safety-ids')
export class AdminSafetyIdsController {
  constructor(
    private readonly safetyIds: AdminSafetyIdsService,
    private readonly transfers: SafetyIdTransferService,
    private readonly labels: LabelsService,
  ) {}

  @Get()
  @AdminAuth(Permission.SAFETY_IDS_READ)
  list(
    @Query() query: AdminSafetyIdQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<PaginatedResult<AdminSafetyIdListItemDto>> {
    return this.safetyIds.list(query, roleHasPermission(admin.role, Permission.CUSTOMERS_READ));
  }

  @Get('metrics')
  @AdminAuth(Permission.SAFETY_IDS_READ)
  metrics() {
    return this.safetyIds.metrics();
  }

  @Get(':id')
  @AdminAuth(Permission.SAFETY_IDS_READ)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminSafetyIdDetailDto> {
    return this.safetyIds.get(id);
  }

  @Get(':id/qr')
  @AdminAuth(Permission.LABELS_READ)
  @RawResponse()
  @ApiProduces('image/svg+xml')
  async qr(@Param('id', new ParseUUIDPipe()) id: string, @Res() res: Response): Promise<void> {
    const { qrUrl } = await this.safetyIds.get(id);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('image/svg+xml').send(await this.labels.qrSvg(qrUrl));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.SAFETY_IDS_MANAGE)
  @ApiOperation({ summary: 'Deactivate the Safety ID (requires recent password confirmation).' })
  deactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SafetyIdReasonDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    return this.safetyIds.deactivate(admin, id, dto.reason, token, meta);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.SAFETY_IDS_MANAGE)
  reactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SafetyIdReasonDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    return this.safetyIds.reactivate(admin, id, dto.reason, meta);
  }

  @Post(':id/qr-integrity')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.QR_INTEGRITY_MANAGE)
  setIntegrity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SafetyIdIntegrityDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    return this.safetyIds.setQrIntegrity(admin, id, dto.status, dto.note, meta);
  }

  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.SAFETY_IDS_MANAGE)
  @ApiOperation({ summary: 'Link to a helmet (both free; same owner or none).' })
  link(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SafetyIdLinkDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    return this.safetyIds.link(admin, id, dto.helmetCode, dto.reason, meta);
  }

  @Post(':id/unlink')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.SAFETY_IDS_MANAGE)
  unlink(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SafetyIdReasonDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    return this.safetyIds.unlink(admin, id, dto.reason, meta);
  }

  @Post(':id/revoke-ownership')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.OWNERSHIP_REVOKE)
  @ApiOperation({ summary: 'Standalone Safety IDs only (requires recent password confirmation).' })
  revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RevokeSafetyIdDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminSafetyIdDetailDto> {
    return this.safetyIds.revokeOwnership(
      admin,
      id,
      dto.reason,
      dto.revokeSessions === true,
      token,
      meta,
    );
  }

  @Delete(':id/transfer')
  @AdminAuth(Permission.TRANSFER_CANCEL)
  async cancelTransfer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ cancelled: true }> {
    await this.transfers.adminCancel(admin, id, meta);
    return { cancelled: true };
  }
}

@ApiTags('admin / safety ID batches')
@Controller('admin/safety-id-batches')
export class AdminSafetyIdBatchesController {
  constructor(
    private readonly batches: SafetyIdBatchesService,
    private readonly exports: ExportsService,
  ) {}

  @Get()
  @AdminAuth(Permission.SAFETY_IDS_READ)
  list(@Query() query: SafetyIdBatchQueryDto): Promise<PaginatedResult<SafetyIdBatchDto>> {
    return this.batches.list(query);
  }

  @Get(':id')
  @AdminAuth(Permission.SAFETY_IDS_READ)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<SafetyIdBatchDto> {
    return this.batches.get(id);
  }

  @Post()
  @AdminAuth(Permission.SAFETY_IDS_GENERATE)
  create(
    @Body() dto: CreateSafetyIdBatchDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SafetyIdBatchDto> {
    return this.batches.create(dto, admin, meta);
  }

  @Post(':id/generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @AdminAuth(Permission.SAFETY_IDS_GENERATE)
  @ApiAcceptedResponse({ description: 'Generation started; poll GET for progress' })
  generate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SafetyIdBatchDto> {
    return this.batches.startGeneration(id, admin, meta);
  }

  @Post(':id/mark-printed')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.SAFETY_IDS_GENERATE)
  @ApiOperation({ summary: 'Labels printed: Safety IDs → PRINTED and PIN escrow purged for good.' })
  markPrinted(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SafetyIdBatchDto> {
    return this.batches.markPrinted(id, admin, meta);
  }

  @Get(':id/export/safety-ids.csv')
  @AdminAuth(Permission.SAFETY_IDS_EXPORT)
  @RawResponse()
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Manufacturing CSV with Activation PINs (while escrowed). Audited.' })
  exportCsv(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    return this.exports.streamSafetyIdCsv(id, admin, meta, res);
  }

  @Get(':id/export/print-sheet.html')
  @AdminAuth(Permission.SAFETY_IDS_EXPORT)
  @RawResponse()
  @ApiProduces('text/html')
  @ApiOperation({
    summary: 'Print-ready sheet: QR + Safety ID + Activation PIN per label. Audited.',
  })
  printSheet(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
    @Res() res: Response,
  ): Promise<void> {
    return this.exports.streamSafetyIdPrintSheet(id, admin, meta, res);
  }
}
