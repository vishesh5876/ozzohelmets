import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module';
import { CustomerHelmetsController } from './customer-helmets.controller';
import { CustomerHelmetsService } from './customer-helmets.service';

@Module({
  imports: [LabelsModule],
  controllers: [CustomerHelmetsController],
  providers: [CustomerHelmetsService],
  exports: [CustomerHelmetsService],
})
export class CustomerHelmetsModule {}
