import { Module } from '@nestjs/common';
import { EmergencyModule } from '../emergency/emergency.module';
import {
  AdminCustomersController,
  AdminPrivacyRequestsController,
  AdminSecurityEventsController,
} from './admin-customers.controller';
import { AdminCustomersService } from './admin-customers.service';
import { PrivacyRequestsService } from './privacy-requests.service';

@Module({
  imports: [EmergencyModule],
  controllers: [
    AdminCustomersController,
    AdminSecurityEventsController,
    AdminPrivacyRequestsController,
  ],
  providers: [AdminCustomersService, PrivacyRequestsService],
  exports: [AdminCustomersService],
})
export class AdminCustomersModule {}
