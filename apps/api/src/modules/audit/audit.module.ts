import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** AuditService only (global). The worker imports this without the admin HTTP controller. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditCoreModule {}

@Module({
  imports: [AuditCoreModule],
  controllers: [AuditController],
})
export class AuditModule {}
