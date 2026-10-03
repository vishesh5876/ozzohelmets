import { Global, Module } from '@nestjs/common';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';

/** Global so every module that changes public-facing data can invalidate the QR page cache. */
@Global()
@Module({
  providers: [PublicEmergencyCacheService],
  exports: [PublicEmergencyCacheService],
})
export class PublicEmergencyCacheModule {}
