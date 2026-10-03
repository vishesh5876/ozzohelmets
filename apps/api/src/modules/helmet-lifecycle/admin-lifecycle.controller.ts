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
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type HelmetReplacementLinksDto,
  type OwnershipPeriodDto,
  Permission,
  type TransferHistoryItemDto,
} from '@helmet/types';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { RecentAuthToken } from '../../common/http/recent-auth-token.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { OwnershipAdminService } from '../ownership/ownership-admin.service';
import { TransferService } from '../ownership/transfer.service';
import { AdminReasonDto, LinkReplacementDto, RevokeOwnershipDto } from './dto/lifecycle.dto';
import { HelmetLifecycleService } from './helmet-lifecycle.service';
import { ReplacementService } from './replacement.service';

const RECENT_AUTH = {
  name: 'X-Recent-Auth',
  required: true,
  description: 'From POST /admin/auth/reauthenticate',
};

/** Support/admin lifecycle and ownership controls — each behind its own permission. */
@ApiTags('admin / ownership & lifecycle')
@Controller('admin/helmets')
export class AdminLifecycleController {
  constructor(
    private readonly ownership: OwnershipAdminService,
    private readonly transfers: TransferService,
    private readonly lifecycle: HelmetLifecycleService,
  ) {}

  @Get(':id/ownership-history')
  @AdminAuth(Permission.OWNERSHIP_VIEW)
  history(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: PaginationQueryDto,
  ): Promise<PaginatedResult<OwnershipPeriodDto>> {
    return this.ownership.history(id, q.page, q.pageSize);
  }

  @Get(':id/transfers')
  @AdminAuth(Permission.OWNERSHIP_VIEW)
  transferHistory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: PaginationQueryDto,
  ): Promise<PaginatedResult<TransferHistoryItemDto>> {
    return this.ownership.transfers(id, q.page, q.pageSize);
  }

  @Delete(':id/transfer')
  @AdminAuth(Permission.TRANSFER_CANCEL)
  @ApiOperation({ summary: 'Cancel the pending transfer of a helmet.' })
  async cancelTransfer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ cancelled: true }> {
    await this.transfers.adminCancel(admin, id, meta);
    return { cancelled: true };
  }

  @Post(':id/revoke-ownership')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.OWNERSHIP_REVOKE)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({ summary: 'Exceptional: end the current ownership (reason + recent password).' })
  async revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RevokeOwnershipDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ revoked: true }> {
    await this.ownership.revoke(admin, id, dto, token, meta);
    return { revoked: true };
  }

  @Post(':id/restore-status')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.HELMET_LIFECYCLE_MANAGE)
  @ApiOperation({
    summary:
      'Restore a lost/stolen/damaged/deactivated owned helmet to its safe operational state.',
  })
  async restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AdminReasonDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ restored: true }> {
    await this.lifecycle.supportRestore(admin, id, dto.reason, meta);
    return { restored: true };
  }

  @Post(':id/force-deactivate')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.HELMET_LIFECYCLE_MANAGE)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({ summary: 'Force DEACTIVATED (reason + recent password).' })
  async forceDeactivate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AdminReasonDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ deactivated: true }> {
    await this.lifecycle.supportDeactivate(admin, id, dto.reason, token, meta);
    return { deactivated: true };
  }
}

@ApiTags('admin / ownership & lifecycle')
@Controller('admin/replacements')
export class AdminReplacementController {
  constructor(private readonly replacements: ReplacementService) {}

  @Post()
  @AdminAuth(Permission.REPLACEMENT_MANAGE)
  @ApiOperation({
    summary:
      'Link an already-activated helmet as the replacement of another owned by the same customer.',
  })
  link(
    @Body() dto: LinkReplacementDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<HelmetReplacementLinksDto> {
    return this.replacements.link(admin, dto, meta);
  }

  @Get(':helmetId')
  @AdminAuth(Permission.HELMETS_READ)
  get(
    @Param('helmetId', new ParseUUIDPipe()) helmetId: string,
  ): Promise<HelmetReplacementLinksDto> {
    return this.replacements.links(helmetId);
  }
}
