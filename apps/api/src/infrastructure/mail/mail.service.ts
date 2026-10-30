import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppConfigService } from '../../config/app-config.service';

export interface MailMessage {
  /** One recipient (never logged in production). */
  to: string;
  subject: string;
  text: string;
  html: string;
}

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Outgoing email. `MAIL_TRANSPORT=resend` posts to the Resend HTTPS API; `smtp` sends through the
 * configured SMTP server (TLS required: implicit on 465, STARTTLS otherwise). `log` writes the
 * message to the API log instead — for development only; in production it refuses to send so
 * codes never end up in logs.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transport: Transporter | null = null;
  private resendKey: string | null = null;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    const mode = this.config.get('MAIL_TRANSPORT');
    if (mode === 'resend') {
      this.resendKey = this.config.get('RESEND_API_KEY') ?? null;
    } else if (mode === 'smtp') {
      const user = this.config.get('SMTP_USER');
      this.transport = createTransport({
        host: this.config.get('SMTP_HOST'),
        port: this.config.get('SMTP_PORT'),
        secure: this.config.get('SMTP_SECURE'),
        requireTLS: !this.config.get('SMTP_SECURE'),
        auth: user ? { user, pass: this.config.get('SMTP_PASSWORD') ?? '' } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    } else if (this.config.isProduction) {
      this.logger.error(
        'MAIL_TRANSPORT is "log": verification and password-reset emails cannot be sent. Set MAIL_TRANSPORT=resend and RESEND_API_KEY in the API environment.',
      );
    }
  }

  /** True when real email can be delivered (or logged in development). */
  get available(): boolean {
    return this.resendKey !== null || this.transport !== null || !this.config.isProduction;
  }

  /** Throws when the message could not be handed to the mail server. */
  async send(message: MailMessage): Promise<void> {
    const from = this.config.get('MAIL_FROM');
    if (this.resendKey) {
      await this.sendResend(from, message);
      return;
    }
    if (this.transport) {
      await this.transport.sendMail({ from, ...message });
      return;
    }
    if (this.config.isProduction) throw new Error('Email is not configured (MAIL_TRANSPORT).');
    this.logger.warn(
      `[MAIL_TRANSPORT=log] To: ${message.to} | Subject: ${message.subject}\n${message.text}`,
    );
  }

  /** SMTP connection + auth check (admin/ops diagnostics). Resend has no dry-run: true when keyed. */
  async verify(): Promise<boolean> {
    if (this.resendKey) return true;
    return this.transport ? this.transport.verify() : false;
  }

  private async sendResend(from: string, message: MailMessage): Promise<void> {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return;
    // Resend errors are { name, message } (e.g. validation_error: domain not verified); never
    // include the recipient or body in the thrown error.
    const detail = await (res.json() as Promise<{ name?: string; message?: string }>)
      .then((b) => `${b.name ?? ''}: ${b.message ?? ''}`)
      .catch(() => '');
    throw new Error(`Resend rejected the email (HTTP ${res.status}) ${detail}`.trim());
  }
}
