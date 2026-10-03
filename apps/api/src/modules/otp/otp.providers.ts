import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '@helmet/types';
import { NotificationService } from '../notifications/notification.service';

/** Delivers a one-time code to a phone number. */
export interface OtpProvider {
  readonly name: string;
  /**
   * When true the API may return the code in its response so local development and automated
   * tests work without SMS. Environment validation forbids such a provider in production.
   */
  readonly exposesCodeForDevelopment: boolean;
  deliver(mobile: string, code: string, ttlSeconds: number): Promise<void>;
}

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

@Injectable()
export class DevelopmentOtpProvider implements OtpProvider {
  readonly name = 'development';
  readonly exposesCodeForDevelopment = true;
  private readonly logger = new Logger(DevelopmentOtpProvider.name);

  async deliver(mobile: string): Promise<void> {
    // The code itself is never logged; it is returned only in the development API response.
    this.logger.warn(`[DEVELOPMENT] OTP issued for ${maskPhone(mobile)} (not sent by SMS)`);
  }
}

@Injectable()
export class SmsOtpProvider implements OtpProvider {
  readonly name = 'sms';
  readonly exposesCodeForDevelopment = false;

  constructor(private readonly notifications: NotificationService) {}

  deliver(mobile: string, code: string, ttlSeconds: number): Promise<void> {
    const minutes = Math.round(ttlSeconds / 60);
    return this.notifications.sendSms({
      to: mobile,
      category: 'OTP',
      body: `${code} is your Helmet ID verification code. It expires in ${minutes} minutes. Never share this code.`,
    });
  }
}
