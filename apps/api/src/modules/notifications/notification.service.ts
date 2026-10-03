import { Inject, Injectable } from '@nestjs/common';
import {
  EMAIL_PROVIDER,
  type EmailMessage,
  type EmailNotificationProvider,
  SMS_PROVIDER,
  type SmsMessage,
  type SmsNotificationProvider,
} from './notification.types';

@Injectable()
export class NotificationService {
  constructor(
    @Inject(SMS_PROVIDER) private readonly sms: SmsNotificationProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailNotificationProvider,
  ) {}

  sendSms(message: SmsMessage): Promise<void> {
    return this.sms.send(message);
  }

  sendEmail(message: EmailMessage): Promise<void> {
    return this.email.send(message);
  }
}
