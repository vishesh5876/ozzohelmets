import { Module } from '@nestjs/common';
import { AdminSystemController, InternalMetricsController } from './system.controller';
import { SystemStatusService } from './system-status.service';

@Module({
  controllers: [AdminSystemController, InternalMetricsController],
  providers: [SystemStatusService],
})
export class SystemModule {}
