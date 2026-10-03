import { Module } from '@nestjs/common';
import { EmergencyModule } from '../emergency/emergency.module';
import { PublicEmergencyController } from './public-emergency.controller';
import { PublicEmergencyService } from './public-emergency.service';

@Module({
  imports: [EmergencyModule],
  controllers: [PublicEmergencyController],
  providers: [PublicEmergencyService],
})
export class PublicEmergencyModule {}
