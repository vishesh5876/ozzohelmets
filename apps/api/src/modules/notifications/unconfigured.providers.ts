import { HttpStatus, Logger } from '@nestjs/common';
import { ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type {
  EmailMessage,
  EmailNotificationProvider,
  SmsMessage,
  SmsNotificationProvider,
} from './notification.types';

/**
 * Placeholder providers until a real SMS/email vendor is chosen. They fail loudly instead of
 * pretending to deliver, and never log message bodies (which may contain OTPs).
 */
export class UnconfiguredSmsProvider implements SmsNotificationProvider {
  readonly name = 'unconfigured-sms';
  private readonly logger = new Logger(UnconfiguredSmsProvider.name);

  async send(message: SmsMessage): Promise<void> {
    this.logger.error(`SMS provider not configured; cannot deliver ${message.category} message`);
    throw new AppException(
      ErrorCode.OTP_DELIVERY_FAILED,
      'Messages cannot be delivered right now. Please try again later.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

export class UnconfiguredEmailProvider implements EmailNotificationProvider {
  readonly name = 'unconfigured-email';
  private readonly logger = new Logger(UnconfiguredEmailProvider.name);

  async send(_message: EmailMessage): Promise<void> {
    this.logger.error('Email provider not configured');
    throw new AppException(
      ErrorCode.SERVICE_UNAVAILABLE,
      'Email delivery is not configured.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
