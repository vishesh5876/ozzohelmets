import { Module } from '@nestjs/common';
import { CustomerSafetyIdsService } from './customer-safety-ids.service';

/** Customer and admin Safety ID features (core transaction rules live in SafetyIdCoreModule). */
@Module({
  providers: [CustomerSafetyIdsService],
  exports: [CustomerSafetyIdsService],
})
export class SafetyIdsModule {}
