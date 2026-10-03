import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';
import { HashingService } from './hashing.service';
import { IpHashService } from './ip-hash.service';
import { RedisRateLimiter } from './redis-rate-limiter.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';

@Global()
@Module({
  providers: [
    HashingService,
    EncryptionService,
    IpHashService,
    RedisThrottlerStorage,
    RedisRateLimiter,
  ],
  exports: [
    HashingService,
    EncryptionService,
    IpHashService,
    RedisThrottlerStorage,
    RedisRateLimiter,
  ],
})
export class SecurityModule {}
