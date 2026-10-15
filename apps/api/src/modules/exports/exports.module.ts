import { Module } from '@nestjs/common';
import { PrintModule } from '../print/print.module';
import { PrintDesignsModule } from '../print-designs/print-designs.module';
import { ExportsService } from './exports.service';

@Module({
  imports: [PrintModule, PrintDesignsModule],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
