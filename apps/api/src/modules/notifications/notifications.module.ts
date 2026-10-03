import { Global, Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { EMAIL_PROVIDER, SMS_PROVIDER } from './notification.types';
import { UnconfiguredEmailProvider, UnconfiguredSmsProvider } from './unconfigured.providers';

@Global()
@Module({
  providers: [
    NotificationService,
    // Swap these bindings for real vendors (e.g. MSG91/Twilio, SES) when chosen.
    { provide: SMS_PROVIDER, useClass: UnconfiguredSmsProvider },
    { provide: EMAIL_PROVIDER, useClass: UnconfiguredEmailProvider },
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
