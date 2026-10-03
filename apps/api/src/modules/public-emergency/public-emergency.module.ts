import { Module } from '@nestjs/common';
import { PublicEmergencyCacheService } from './public-emergency-cache.service';
import { PublicEmergencyController } from './public-emergency.controller';
import { PublicEmergencyService } from './public-emergency.service';

@Module({
  controllers: [PublicEmergencyController],
  providers: [PublicEmergencyService, PublicEmergencyCacheService],
  exports: [PublicEmergencyCacheService],
})
export class PublicEmergencyModule {}
