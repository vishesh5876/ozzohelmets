import { CustomerAccountModule } from '../customer-account/customer-account.module';
import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module';
import { SafetyIdsModule } from '../safety-ids/safety-ids.module';
import { CustomerHelmetsController } from './customer-helmets.controller';
import { CustomerHelmetsService } from './customer-helmets.service';

@Module({
  imports: [LabelsModule, CustomerAccountModule, SafetyIdsModule],
  controllers: [CustomerHelmetsController],
  providers: [CustomerHelmetsService],
  exports: [CustomerHelmetsService],
})
export class CustomerHelmetsModule {}
