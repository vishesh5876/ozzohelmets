import { Module } from '@nestjs/common';
import { EmergencyModule } from '../emergency/emergency.module';
import { WarrantyModule } from '../warranty/warranty.module';
import { PublicEmergencyController, PublicVerifyController } from './public-emergency.controller';
import {
  EmergencyPageExceptionFilter,
  PublicEmergencyPageController,
} from './public-emergency-page.controller';
import { PublicAbuseService } from './public-abuse.service';
import { PublicEmergencyService } from './public-emergency.service';

@Module({
  imports: [EmergencyModule, WarrantyModule],
  controllers: [PublicEmergencyController, PublicVerifyController, PublicEmergencyPageController],
  providers: [PublicEmergencyService, PublicAbuseService, EmergencyPageExceptionFilter],
})
export class PublicEmergencyModule {}
