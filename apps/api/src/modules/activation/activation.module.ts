import { Module } from '@nestjs/common';
import { CustomerHelmetsModule } from '../customer-helmets/customer-helmets.module';
import { HelmetsModule } from '../helmets/helmets.module';
import { ActivationController } from './activation.controller';
import { ActivationService } from './activation.service';
import { ActivationPolicy } from './domain/activation-policy';

@Module({
  imports: [HelmetsModule, CustomerHelmetsModule],
  controllers: [ActivationController],
  providers: [ActivationService, ActivationPolicy],
})
export class ActivationModule {}
