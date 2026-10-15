import { Module } from '@nestjs/common';
import { EmergencyModule } from '../emergency/emergency.module';
import { ExportsModule } from '../exports/exports.module';
import { LabelsModule } from '../labels/labels.module';
import { PrintModule } from '../print/print.module';
import { PrintDesignsModule } from '../print-designs/print-designs.module';
import {
  AdminSafetyIdBatchesController,
  AdminSafetyIdsController,
} from './admin-safety-ids.controller';
import { AdminSafetyIdsService } from './admin-safety-ids.service';
import {
  CustomerSafetyIdsController,
  SafetyIdClaimController,
} from './customer-safety-ids.controller';
import { CustomerSafetyIdsService } from './customer-safety-ids.service';
import { SafetyIdBatchesService } from './safety-id-batches.service';
import { SafetyIdTransferService } from './safety-id-transfer.service';

/** Customer and admin Safety ID features (core transaction rules live in SafetyIdCoreModule). */
@Module({
  imports: [EmergencyModule, ExportsModule, LabelsModule, PrintModule, PrintDesignsModule],
  controllers: [
    CustomerSafetyIdsController,
    SafetyIdClaimController,
    AdminSafetyIdsController,
    AdminSafetyIdBatchesController,
  ],
  providers: [
    CustomerSafetyIdsService,
    SafetyIdTransferService,
    AdminSafetyIdsService,
    SafetyIdBatchesService,
  ],
  exports: [CustomerSafetyIdsService, AdminSafetyIdsService],
})
export class SafetyIdsModule {}
