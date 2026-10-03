import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';
import { HashingService } from './hashing.service';
import { IpHashService } from './ip-hash.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';

@Global()
@Module({
  providers: [HashingService, EncryptionService, IpHashService, RedisThrottlerStorage],
  exports: [HashingService, EncryptionService, IpHashService, RedisThrottlerStorage],
})
export class SecurityModule {}
