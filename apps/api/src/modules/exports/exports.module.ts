import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module';
import { ExportsService } from './exports.service';

@Module({
  imports: [LabelsModule],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
