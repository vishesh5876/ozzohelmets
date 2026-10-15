import { Module } from '@nestjs/common';
import { PrintModule } from '../print/print.module';
import { ExportsService } from './exports.service';

@Module({
  imports: [PrintModule],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
