import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { NotificationService } from '../notifications/notification.service';
import { DevelopmentOtpProvider, OTP_PROVIDER, SmsOtpProvider } from './otp.providers';
import { OtpService } from './otp.service';
import { OTP_STORE, RedisOtpStore } from './otp.store';

@Module({
  providers: [
    OtpService,
    { provide: OTP_STORE, useClass: RedisOtpStore },
    {
      provide: OTP_PROVIDER,
      inject: [AppConfigService, NotificationService],
      useFactory: (config: AppConfigService, notifications: NotificationService) =>
        config.get('OTP_PROVIDER') === 'development'
          ? new DevelopmentOtpProvider()
          : new SmsOtpProvider(notifications),
    },
  ],
  exports: [OtpService],
})
export class OtpModule {}
