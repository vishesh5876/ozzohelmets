import { Module } from '@nestjs/common';
import { HelmetsModule } from '../helmets/helmets.module';
import { WarrantyPolicyService } from './domain/warranty-policy';
import { WarrantyAdminService } from './warranty-admin.service';
import { AdminWarrantyController, CustomerWarrantyController } from './warranty.controller';
import { WarrantyService } from './warranty.service';

/** Phase 4: helmet warranty (coverage, proof of purchase, admin corrections). */
@Module({
  imports: [HelmetsModule],
  controllers: [CustomerWarrantyController, AdminWarrantyController],
  providers: [WarrantyPolicyService, WarrantyService, WarrantyAdminService],
  exports: [WarrantyService, WarrantyPolicyService],
})
export class WarrantyModule {}
