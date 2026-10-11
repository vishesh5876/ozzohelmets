import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AnalyticsOverviewDto,
  type CursorPage,
  type CustomerScanSummaryDto,
  type SafetyIdActivityItemDto,
  type SafetyIdAnalyticsDetailDto,
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
  @ApiOperation({ summary: 'Public QR scan analytics: totals, trend, top Safety IDs.' })
  scans(@Query() q: AnalyticsRangeQueryDto): Promise<ScanAnalyticsDto> {
    return this.analytics.scans(resolveRange(q.range, q.from, q.to));
  }

  @Get('safety-ids')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({
    summary: 'Safety IDs with unusual QR activity (cursor-paginated by risk score).',
  })
  safetyIds(@Query() q: HelmetActivityQueryDto): Promise<CursorPage<SafetyIdActivityItemDto>> {
    return this.analytics.safetyIdActivity(q);
  }

  /** Phase 8 path kept for older admin builds (same Safety-ID-centric list). */
  @Get('helmets')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Deprecated alias of /safety-ids.', deprecated: true })
  helmets(@Query() q: HelmetActivityQueryDto): Promise<CursorPage<SafetyIdActivityItemDto>> {
    return this.analytics.safetyIdActivity(q);
  }

  @Get('safety-ids/:code')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({
    summary:
      'One Safety ID (SI-… or a linked HM-…): scan trend, explainable risk, alerts (if permitted), reports.',
  })
  safetyId(
    @Param('code') code: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<SafetyIdAnalyticsDetailDto> {
    return this.analytics.safetyIdDetail(
      code,
      roleHasPermission(admin.role, Permission.RISK_ALERT_VIEW),
    );
  }

  @Get('helmets/:helmetCode')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: "Deprecated: the helmet's linked Safety ID.", deprecated: true })
  helmet(
    @Param('helmetCode') helmetCode: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<SafetyIdAnalyticsDetailDto> {
    return this.analytics.safetyIdDetail(
      helmetCode,
      roleHasPermission(admin.role, Permission.RISK_ALERT_VIEW),
    );
  }

  @Get('safety-ids/:code/scans')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({
    summary: 'Scan events (type, time, device class, cache) — no IPs. Cursor-paginated.',
  })
  safetyIdScans(
    @Param('code') code: string,
    @Query() q: CursorQueryDto,
  ): Promise<CursorPage<HelmetScanEventDto>> {
    return this.analytics.safetyIdScans(code, q.cursor, q.limit);
  }

  @Get('helmets/:helmetCode/scans')
  @AdminAuth(Permission.ANALYTICS_VIEW)
  @ApiOperation({ summary: 'Deprecated alias (linked Safety ID).', deprecated: true })
  helmetScans(
    @Param('helmetCode') helmetCode: string,
    @Query() q: CursorQueryDto,
  ): Promise<CursorPage<HelmetScanEventDto>> {
    return this.analytics.safetyIdScans(helmetCode, q.cursor, q.limit);
  }

  @Patch('safety-ids/:code/qr-integrity')
  @AdminAuth(Permission.QR_INTEGRITY_MANAGE)
  @ApiOperation({
    summary:
      'Human decision: NORMAL / UNDER_REVIEW / COMPROMISED. Audited. Never changes lifecycle or emergency access.',
  })
  qrIntegrity(
    @Param('code') code: string,
    @Body() dto: QrIntegrityDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SafetyIdAnalyticsDetailDto> {
    return this.analytics.setQrIntegrity(admin, code, dto.status, dto.note, meta);
  }

  @Patch('helmets/:helmetCode/qr-integrity')
  @AdminAuth(Permission.QR_INTEGRITY_MANAGE)
  @ApiOperation({ summary: 'Deprecated alias (linked Safety ID).', deprecated: true })
  helmetQrIntegrity(
    @Param('helmetCode') helmetCode: string,
    @Body() dto: QrIntegrityDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SafetyIdAnalyticsDetailDto> {
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
  @ApiOperation({
    summary: 'Acknowledge / investigate / resolve / dismiss (reason) / assign. Audited.',
  })
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
@ApiTags('customer / safety IDs')
@Controller('customer')
@CustomerAuth()
export class CustomerScanSummaryController {
  constructor(private readonly analytics: AnalyticsQueryService) {}

  @Get('safety-ids/:id/scan-summary')
  summary(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerScanSummaryDto> {
    return this.analytics.customerSummary(c.id, id);
  }

  /** Phase 8 path: the helmet's linked Safety ID. */
  @Get('helmets/:id/scan-summary')
  helmetSummary(
    @CurrentCustomer() c: AuthenticatedCustomer,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomerScanSummaryDto> {
    return this.analytics.customerSummaryForHelmet(c.id, id);
  }
}
