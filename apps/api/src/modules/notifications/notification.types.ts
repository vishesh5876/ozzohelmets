/**
 * Notification foundation. Phase 2 only sends OTP SMS; future events (helmet activated,
 * profile enabled, scan alerts, ownership transfer) plug in here without touching callers.
 */
export interface SmsMessage {
  /** E.164 recipient. */
  to: string;
  body: string;
  /** Category used for provider routing/templates (e.g. DLT templates in India). */
  category: 'OTP' | 'TRANSACTIONAL';
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SmsNotificationProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<void>;
}

export interface EmailNotificationProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
