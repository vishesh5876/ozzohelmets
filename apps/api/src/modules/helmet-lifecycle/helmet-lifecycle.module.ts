import { Module } from '@nestjs/common';
import { CustomerHelmetsModule } from '../customer-helmets/customer-helmets.module';
import { HelmetsModule } from '../helmets/helmets.module';
import { OwnershipModule } from '../ownership/ownership.module';
import { AdminLifecycleController, AdminReplacementController } from './admin-lifecycle.controller';
import { CustomerLifecycleController } from './customer-lifecycle.controller';
import { HelmetLifecycleService } from './helmet-lifecycle.service';
import { ReplacementService } from './replacement.service';

/** Owner lifecycle actions, support restore/deactivation and replacement links (Phase 3). */
@Module({
  imports: [HelmetsModule, CustomerHelmetsModule, OwnershipModule],
  controllers: [CustomerLifecycleController, AdminLifecycleController, AdminReplacementController],
  providers: [HelmetLifecycleService, ReplacementService],
  exports: [HelmetLifecycleService, ReplacementService],
})
export class HelmetLifecycleModule {}
