import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module';
import { OwnedHelmetLocker } from './domain/owned-helmet.locker';
import { HelmetStatusService } from './domain/helmet-status.service';
import { HelmetsController } from './helmets.controller';
import { HelmetsService } from './helmets.service';

@Module({
  imports: [LabelsModule],
  controllers: [HelmetsController],
  providers: [HelmetsService, HelmetStatusService, OwnedHelmetLocker],
  exports: [HelmetsService, HelmetStatusService, OwnedHelmetLocker],
})
export class HelmetsModule {}
