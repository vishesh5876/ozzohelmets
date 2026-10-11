import { Global, Module } from '@nestjs/common';
import { HelmetsModule } from '../helmets/helmets.module';
import { SafetyIdCoreService } from './domain/safety-id-core.service';
import { SafetyIdGenerationService } from './generation/safety-id-generation.service';

/**
 * Transaction-level Safety ID rules and generation, shared by activation, sharing, lifecycle,
 * transfers and helmet batch generation.
 */
@Global()
@Module({
  imports: [HelmetsModule],
  providers: [SafetyIdCoreService, SafetyIdGenerationService],
  exports: [SafetyIdCoreService, SafetyIdGenerationService],
})
export class SafetyIdCoreModule {}
