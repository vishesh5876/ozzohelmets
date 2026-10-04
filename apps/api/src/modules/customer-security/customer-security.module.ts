import { Global, Module } from '@nestjs/common';
import { SecurityEventsService } from './security-events.service';

/** Global: auth, activation, transfer, lifecycle and admin modules all record security events. */
@Global()
@Module({
  providers: [SecurityEventsService],
  exports: [SecurityEventsService],
})
export class CustomerSecurityModule {}
