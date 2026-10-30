import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { ErrorCode, type NormalizedEmail } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { MailService } from '../../infrastructure/mail/mail.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { opaqueToken } from '../../security/secure-random';
import { emailCodeMessage } from './email-templates';

/** What a code proves: a new account's address, a changed address, or a password reset. */
export type EmailOtpPurpose = 'signup' | 'email-change' | 'password-reset';

export interface EmailOtpSent {
  /** Seconds the code stays valid. */
  expiresIn: number;
  /** Seconds before another code can be requested for this address. */
  resendIn: number;
}

/**
 * Six-digit email codes. Only an HMAC of the code is stored (Redis, short TTL), bound to the
 * purpose, the canonical address and (for signed-in changes) the account. Every code is single
 * use; wrong guesses are counted and the code is destroyed after EMAIL_OTP_MAX_ATTEMPTS. Sending
 * is limited per address (cool-down + hourly cap) and per IP. Addresses never appear in Redis
 * keys or logs in clear: keys use keyed hashes.
 */
@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly mail: MailService,
    private readonly limiter: RedisRateLimiter,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Issues and emails a code. `deliver: false` applies every limit and returns the same answer
   * without sending anything (password reset for an unknown address: no account enumeration).
   */
  async send(
    purpose: EmailOtpPurpose,
    email: NormalizedEmail,
    meta: RequestMeta,
    opts: { userId?: string; deliver?: boolean } = {},
  ): Promise<EmailOtpSent> {
    const ttl = this.config.get('EMAIL_OTP_TTL_SECONDS');
    const cooldown = this.config.get('EMAIL_OTP_RESEND_SECONDS');
    const addr = this.hash(`addr:${email.normalized}`);
    if (!this.mail.available)
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Email codes are temporarily unavailable. Please try again later.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );

    const ip = await this.limiter.hit(
      `email-otp:ip:${meta.ipHash}`,
      this.config.get('EMAIL_OTP_MAX_SENDS_PER_IP_PER_HOUR'),
      3600,
    );
    if (!ip.allowed) throw this.tooMany(ip.retryAfter);
    // Cool-down per address and purpose: one code per EMAIL_OTP_RESEND_SECONDS.
    const cool = await this.redis.set(
      `email-otp-cool:${purpose}:${addr}`,
      '1',
      'EX',
      cooldown,
      'NX',
    );
    if (cool !== 'OK') {
      const left = await this.redis.ttl(`email-otp-cool:${purpose}:${addr}`);
      throw this.tooMany(Math.max(left, 1), 'Please wait before asking for another code.');
    }
    const hourly = await this.limiter.hit(
      `email-otp:addr:${addr}`,
      this.config.get('EMAIL_OTP_MAX_SENDS_PER_ADDRESS_PER_HOUR'),
      3600,
    );
    if (!hourly.allowed) throw this.tooMany(hourly.retryAfter);

    if (opts.deliver !== false) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const key = this.key(purpose, email, opts.userId);
      await this.redis
        .multi()
        .del(key)
        .hset(key, { code: this.hash(`code:${key}:${code}`), attempts: '0' })
        .expire(key, ttl)
        .exec();
      try {
        await this.mail.send({ to: email.email, ...emailCodeMessage(purpose, code, ttl) });
      } catch (err) {
        await this.redis.del(key, `email-otp-cool:${purpose}:${addr}`);
        this.logger.error(`Email code delivery failed: ${(err as Error).message}`);
        throw new AppException(
          ErrorCode.SERVICE_UNAVAILABLE,
          'We could not send the email. Check the address and try again in a moment.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }
    return { expiresIn: ttl, resendIn: cooldown };
  }

  /**
   * True once for the right code. Each wrong guess counts; after the last allowed attempt the
   * code is destroyed. Never reveals whether a code exists.
   */
  async verify(
    purpose: EmailOtpPurpose,
    email: NormalizedEmail,
    rawCode: string,
    userId?: string,
  ): Promise<boolean> {
    const code = rawCode.replace(/\D/g, '');
    const key = this.key(purpose, email, userId);
    const attempts = await this.redis.hincrby(key, 'attempts', 1);
    const stored = await this.redis.hget(key, 'code');
    if (!stored) {
      // HINCRBY created a stray hash for a missing code: remove it.
      await this.redis.del(key);
      return false;
    }
    const expected = Buffer.from(stored, 'hex');
    const given = Buffer.from(this.hash(`code:${key}:${code}`), 'hex');
    const ok = code.length === 6 && timingSafeEqual(expected, given);
    if (ok) return (await this.redis.del(key)) === 1; // single use, even under races
    if (attempts >= this.config.get('EMAIL_OTP_MAX_ATTEMPTS')) await this.redis.del(key);
    return false;
  }

  /** A short-lived proof that `email` was verified (finishing sign-up in a later request). */
  async issueProof(email: NormalizedEmail): Promise<{ emailProof: string; expiresIn: number }> {
    const token = opaqueToken(32);
    const ttl = this.config.get('EMAIL_PROOF_TTL_SECONDS');
    await this.redis.set(this.proofKey(token), this.hash(`addr:${email.normalized}`), 'EX', ttl);
    return { emailProof: token, expiresIn: ttl };
  }

  /** Whether the proof is valid for this address (not consumed). */
  async checkProof(token: string | undefined, email: NormalizedEmail): Promise<boolean> {
    if (!token || token.length > 128) return false;
    const stored = await this.redis.get(this.proofKey(token));
    return stored !== null && stored === this.hash(`addr:${email.normalized}`);
  }

  async consumeProof(token: string | undefined): Promise<void> {
    if (token && token.length <= 128) await this.redis.del(this.proofKey(token));
  }

  invalidCode(): AppException {
    return new AppException(
      ErrorCode.EMAIL_CODE_INVALID,
      'That code is wrong or has expired. Check the latest email, or ask for a new code.',
      HttpStatus.BAD_REQUEST,
    );
  }

  private key(purpose: EmailOtpPurpose, email: NormalizedEmail, userId?: string): string {
    return `email-otp:${purpose}:${this.hash(`addr:${email.normalized}:${userId ?? ''}`)}`;
  }

  private proofKey(token: string): string {
    return `email-proof:${this.hash(`proof:${token}`)}`;
  }

  /** Keyed hash (the credential pepper): Redis contents reveal neither addresses nor codes. */
  private hash(v: string): string {
    return createHmac('sha256', this.config.get('CUSTOMER_CREDENTIAL_PEPPER'))
      .update(v)
      .digest('hex');
  }

  private tooMany(retryAfter: number, message = 'Too many codes requested. Try again later.') {
    return new AppException(ErrorCode.RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS, {
      retryAfter,
    });
  }
}
