import { Global, Module } from '@nestjs/common';
import {
  AdminAnalyticsController,
  AdminRiskAlertsController,
  CustomerScanSummaryController,
} from './analytics.controller';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsQueryService } from './analytics-query.service';
import { JobRunnerService } from './job-runner.service';
import { RetentionService } from './retention.service';
import { RiskAlertsService } from './risk-alerts.service';
import { RiskEvaluationService } from './risk-evaluation.service';

const SERVICES = [
  AnalyticsAggregationService,
  AnalyticsQueryService,
  RiskAlertsService,
  RiskEvaluationService,
  RetentionService,
  JobRunnerService,
];

/**
 * Services only (no controllers): shared by the API (public abuse detection raises alerts) and
 * the worker process (aggregation, risk evaluation, retention). Global so the public module can
 * use RiskAlertsService without import cycles.
 */
@Global()
@Module({ providers: SERVICES, exports: SERVICES })
export class AnalyticsCoreModule {}

/** HTTP surface (API process only). */
@Module({
  imports: [AnalyticsCoreModule],
  controllers: [AdminAnalyticsController, AdminRiskAlertsController, CustomerScanSummaryController],
})
export class AnalyticsModule {}
