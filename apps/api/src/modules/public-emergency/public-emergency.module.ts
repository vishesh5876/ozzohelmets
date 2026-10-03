import { Module } from '@nestjs/common';
import { EmergencyModule } from '../emergency/emergency.module';
import { WarrantyModule } from '../warranty/warranty.module';
import { PublicEmergencyController, PublicVerifyController } from './public-emergency.controller';
import { PublicEmergencyService } from './public-emergency.service';

@Module({
  imports: [EmergencyModule, WarrantyModule],
  controllers: [PublicEmergencyController, PublicVerifyController],
  providers: [PublicEmergencyService],
})
export class PublicEmergencyModule {}
