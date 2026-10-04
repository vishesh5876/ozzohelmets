import { Module } from '@nestjs/common';
import { ExportsService } from './exports.service';

@Module({
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
