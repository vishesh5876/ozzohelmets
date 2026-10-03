import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module';
import { PublicEmergencyModule } from '../public-emergency/public-emergency.module';
import { HelmetStatusService } from './domain/helmet-status.service';
import { HelmetsController } from './helmets.controller';
import { HelmetsService } from './helmets.service';

@Module({
  imports: [LabelsModule, PublicEmergencyModule],
  controllers: [HelmetsController],
  providers: [HelmetsService, HelmetStatusService],
  exports: [HelmetsService, HelmetStatusService],
})
export class HelmetsModule {}
