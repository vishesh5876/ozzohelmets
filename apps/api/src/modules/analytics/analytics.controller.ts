import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AnalyticsOverviewDto,
  type CursorPage,
  type CustomerScanSummaryDto,
  type HelmetActivityItemDto,
  type HelmetAnalyticsDetailDto,
  type HelmetScanEventDto,
  Permission,
  type RiskAlertDto,
  roleHasPermission,
  type ScanAnalyticsDto,
} from '@helmet/types';
import { ReqMeta, type RequestMeta } from '../../common/utils/request-context';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AdminAuth } from '../admin-auth/decorators/admin-auth.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CurrentCustomer } from '../customer-auth/decorators/current-customer.decorator';
import { CustomerAuth } from '../customer-auth/decorators/customer-auth.decorator';
import { AnalyticsQueryService, resolveRange } from './analytics-query.service';
import {
  AnalyticsRangeQueryDto,
  CursorQueryDto,
  HelmetActivityQueryDto,
  QrIntegrityDto,
  RiskAlertQueryDto,
  UpdateRiskAlertDto,
} from './dto/analytics.dto';
import { RiskAlertsService } from './risk-alerts.service';

/** Aggregate analytics. Never medical data, never visitor identities (no IPs or IP hashes). */
@ApiTags('admin / analytics')
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly analytics: AnalyticsQueryService) {}

  @Get('overview')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Operational metrics and daily series (aggregates; today live).' })
  overview(@Query() q: AnalyticsRangeQueryDto): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(resolveRange(q.range, q.from, q.to));
  }

  @Get('scans')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Public QR scan analytics: totals, trend, top helmets.' })
  scans(@Query() q: AnalyticsRangeQueryDto): Promise<ScanAnalyticsDto> {
    return this.analytics.scans(resolveRange(q.range, q.from, q.to));
  }

  @Get('helmets')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Helmets with unusual QR activity (cursor-paginated by risk score).' })
  helmets(@Query() q: HelmetActivityQueryDto): Promise<CursorPage<HelmetActivityItemDto>> {
    return this.analytics.helmetActivity(q);
  }

  @Get('helmets/:helmetCode')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'One helmet: scan trend, explainable risk, alerts (if permitted), reports.' })
  helmet(
    @Param('helmetCode') helmetCode: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<HelmetAnalyticsDetailDto> {
    return this.analytics.helmetDetail(
      helmetCode,
      roleHasPermission(admin.role, Permission.RISK_ALERT_VIEW),
    );
  }

  @Get('helmets/:helmetCode/scans')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Scan events (type, time, device class, cache) — no IPs. Cursor-paginated.' })
  helmetScans(
    @Param('helmetCode') helmetCode: string,
    @Query() q: CursorQueryDto,
  ): Promise<CursorPage<HelmetScanEventDto>> {
    return this.analytics.helmetScans(helmetCode, q.cursor, q.limit);
  }

  @Patch('helmets/:helmetCode/qr-integrity')
  @AdminAuth(Permission.QR_INTEGRITY_MANAGE)
  @ApiOperation({
    summary:
      'Human decision: NORMAL / UNDER_REVIEW / COMPROMISED. Audited. Never changes lifecycle or emergency access.',
  })
  qrIntegrity(
    @Param('helmetCode') helmetCode: string,
    @Body() dto: QrIntegrityDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<HelmetAnalyticsDetailDto> {
    return this.analytics.setQrIntegrity(admin, helmetCode, dto.status, dto.note, meta);
  }
}

@ApiTags('admin / risk alerts')
@Controller('admin/risk-alerts')
export class AdminRiskAlertsController {
  constructor(private readonly alerts: RiskAlertsService) {}

  @Get()
  @AdminAuth(Permission.RISK_ALERT_VIEW)
  @ApiOperation({ summary: 'Risk alerts, newest activity first (cursor-paginated).' })
  list(@Query() q: RiskAlertQueryDto): Promise<CursorPage<RiskAlertDto>> {
    return this.alerts.list(q);
  }

  @Get(':id')
  @AdminAuth(Permission.RISK_ALERT_VIEW)
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<RiskAlertDto> {
    return this.alerts.get(id);
  }

  @Patch(':id')
  @AdminAuth(Permission.RISK_ALERT_MANAGE)
  @ApiOperation({ summary: 'Acknowledge / investigate / resolve / dismiss (reason) / assign. Audited.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRiskAlertDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<RiskAlertDto> {
    return this.alerts.update(admin, id, dto, meta);
  }
}

/** Owner-facing neutral scan counts. No IPs, devices, locations or risk internals. */
@ApiTags('customer-helmets')
@Controller('customer/helmets')
@CustomerAuth()
export class CustomerScanSummaryController {
  constructor(private readonly analytics: AnalyticsQueryService) {}

  @Get(':id/scan-summary')
  summary(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerScanSummaryDto> {
    return this.analytics.customerSummary(c.id, id);
  }
}
