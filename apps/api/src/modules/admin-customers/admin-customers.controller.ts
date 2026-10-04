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
  type AdminCustomerDetailDto,
  type AdminCustomerSearchResponse,
  type AdminPrivacyRequestDto,
  type AdminSecurityEventDto,
  CustomerSecurityEventType,
  Permission,
  type RecoveryGrantIssuedDto,
} from '@helmet/types';
import { RecentAuthToken } from '../../common/http/recent-auth-token.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { SecurityEventsService } from '../customer-security/security-events.service';
import { AdminCustomersService } from './admin-customers.service';
import {
  ConfirmedCustomerActionDto,
  CustomerReasonDto,
  CustomerSearchQueryDto,
  CustomerStatusChangeDto,
  PrivacyRequestListQueryDto,
  PrivacyRequestReviewDto,
  SecurityEventQueryDto,
} from './dto/admin-customers.dto';
import { PrivacyRequestsService } from './privacy-requests.service';

const RECENT_AUTH = {
  name: 'X-Recent-Auth',
  required: true,
  description: 'From POST /admin/auth/reauthenticate',
};

const isEventType = (t: string | undefined): t is CustomerSecurityEventType =>
  !!t && t in CustomerSecurityEventType;

/** Customer support. Accounts are addressed by Customer ID (`CU-…`), never by internal id. */
@ApiTags('admin-customers')
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(
    private readonly customers: AdminCustomersService,
    private readonly events: SecurityEventsService,
  ) {}

  @Get()
  @AdminAuth(Permission.CUSTOMERS_READ)
  @ApiOperation({
    summary:
      'Search customers: exact Customer ID / Helmet ID, partial email or name (≥3 chars). Paginated.',
  })
  search(@Query() q: CustomerSearchQueryDto): Promise<AdminCustomerSearchResponse> {
    return this.customers.search(q);
  }

  @Get(':customerId')
  @AdminAuth(Permission.CUSTOMERS_READ)
  @ApiOperation({ summary: 'Operational account summary (no medical data, no secrets). Audited.' })
  detail(
    @Param('customerId') customerId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminCustomerDetailDto> {
    return this.customers.detail(admin, customerId, meta);
  }

  @Post(':customerId/status')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.CUSTOMERS_MANAGE)
  @ApiOperation({
    summary:
      'Suspend / lock / restore. Suspend and lock end all sessions; emergency QR info is unaffected.',
  })
  status(
    @Param('customerId') customerId: string,
    @Body() dto: CustomerStatusChangeDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminCustomerDetailDto> {
    return this.customers.changeStatus(admin, customerId, dto.action, dto.reason, meta);
  }

  @Post(':customerId/logout-all')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.CUSTOMERS_MANAGE)
  @ApiOperation({ summary: 'Force sign-out of every customer session (reason required).' })
  logoutAll(
    @Param('customerId') customerId: string,
    @Body() dto: CustomerReasonDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ revoked: true }> {
    return this.customers.forceLogout(admin, customerId, dto.reason, meta);
  }

  @Post(':customerId/delete')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @AdminAuth(Permission.CUSTOMERS_DELETE)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({
    summary:
      'SUPER_ADMIN: mark the account deleted (irreversible). Records are retained; sharing switched off.',
  })
  markDeleted(
    @Param('customerId') customerId: string,
    @Body() dto: ConfirmedCustomerActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminCustomerDetailDto> {
    return this.customers.markDeleted(admin, customerId, dto, token, meta);
  }

  @Post(':customerId/recovery-grants')
  @RateLimit('auth')
  @AdminAuth(Permission.CUSTOMER_RECOVERY_GRANT)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({
    summary:
      'SUPER_ADMIN last resort: one-time, short-lived recovery credential (shown once, never emailed).',
  })
  issueGrant(
    @Param('customerId') customerId: string,
    @Body() dto: ConfirmedCustomerActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<RecoveryGrantIssuedDto> {
    return this.customers.issueRecoveryGrant(admin, customerId, dto, token, meta);
  }

  @Delete(':customerId/recovery-grants')
  @AdminAuth(Permission.CUSTOMER_RECOVERY_GRANT)
  @ApiOperation({ summary: 'Revoke the open recovery grant, if any.' })
  revokeGrant(
    @Param('customerId') customerId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ revoked: boolean }> {
    return this.customers.revokeRecoveryGrant(admin, customerId, meta);
  }

  @Get(':customerId/security-events')
  @AdminAuth(Permission.SECURITY_EVENTS_VIEW)
  @ApiOperation({ summary: 'SUPER_ADMIN: the customer’s security events (no IP, no secrets).' })
  async customerEvents(@Param('customerId') customerId: string): Promise<AdminSecurityEventDto[]> {
    const user = await this.customers.findByCustomerId(customerId);
    return this.events.forAdmin({ customerId: user.customerCode, limit: 100 });
  }
}

@ApiTags('admin-customers')
@Controller('admin/security-events')
export class AdminSecurityEventsController {
  constructor(private readonly events: SecurityEventsService) {}

  @Get()
  @AdminAuth(Permission.SECURITY_EVENTS_VIEW)
  @ApiOperation({ summary: 'SUPER_ADMIN: recent customer security events across accounts.' })
  list(@Query() q: SecurityEventQueryDto): Promise<AdminSecurityEventDto[]> {
    return this.events.forAdmin({
      customerId: q.customerId?.trim().toUpperCase(),
      type: isEventType(q.type) ? q.type : undefined,
      limit: q.limit,
    });
  }
}

@ApiTags('admin-privacy')
@Controller('admin/privacy-requests')
export class AdminPrivacyRequestsController {
  constructor(private readonly requests: PrivacyRequestsService) {}

  @Get()
  @AdminAuth(Permission.PRIVACY_REQUESTS_VIEW)
  @ApiOperation({ summary: 'Customer privacy requests (account deletion). No medical content.' })
  list(@Query() q: PrivacyRequestListQueryDto): Promise<AdminPrivacyRequestDto[]> {
    return this.requests.list(q.status);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.PRIVACY_REQUESTS_MANAGE)
  approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PrivacyRequestReviewDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminPrivacyRequestDto> {
    return this.requests.review(admin, id, 'APPROVE', dto.note, undefined, meta);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @AdminAuth(Permission.PRIVACY_REQUESTS_MANAGE)
  reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PrivacyRequestReviewDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminPrivacyRequestDto> {
    return this.requests.review(admin, id, 'REJECT', dto.note, undefined, meta);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @AdminAuth(Permission.PRIVACY_REQUESTS_MANAGE)
  @ApiHeader(RECENT_AUTH)
  @ApiOperation({
    summary:
      'Complete an approved request: marks the account deleted (recent password). No data is erased.',
  })
  complete(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PrivacyRequestReviewDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @RecentAuthToken() token: string | undefined,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminPrivacyRequestDto> {
    return this.requests.review(admin, id, 'COMPLETE', dto.note, token, meta);
  }
}
