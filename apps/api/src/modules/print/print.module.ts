import { Module } from '@nestjs/common';
import { AdminSafetyIdPrintController } from './admin-print.controller';
import { PrintService } from './print.service';

/** Phase 9 Safety ID print engine (true-size vector PDF, previews, cut guide). */
@Module({
  controllers: [AdminSafetyIdPrintController],
  providers: [PrintService],
  exports: [PrintService],
})
export class PrintModule {}
