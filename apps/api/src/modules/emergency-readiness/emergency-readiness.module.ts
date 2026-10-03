import { Global, Module } from '@nestjs/common';
import { EmergencyReadinessService } from './emergency-readiness.service';

@Global()
@Module({
  providers: [EmergencyReadinessService],
  exports: [EmergencyReadinessService],
})
export class EmergencyReadinessModule {}
