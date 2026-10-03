import { createHmac, randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode, OTP_LENGTH, OTP_REGEX } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { OTP_PROVIDER, type OtpProvider } from './otp.providers';
import { OTP_STORE, type OtpStore } from './otp.store';

export type OtpPurpose = 'login';

export interface OtpIssueResult {
  expiresIn: number;
  resendAfter: number;
  /** Present only with a development provider. */
  devOtp?: string;
}

/** Cryptographically secure, uniformly distributed 6-digit code. */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * OTP lifecycle: issue (with layered abuse limits) and verify (atomic, attempt-capped, single
 * use). Phone numbers must already be normalised to E.164. Redis keys and stored values use
 * keyed hashes, so neither phone numbers nor codes are stored in plaintext.
 */
@Injectable()
export class OtpService {
  private readonly secret: string;

  constructor(
    @Inject(OTP_STORE) private readonly store: OtpStore,
    @Inject(OTP_PROVIDER) private readonly provider: OtpProvider,
    private readonly limiter: RedisRateLimiter,
    private readonly config: AppConfigService,
  ) {
    this.secret = config.get('OTP_HASH_SECRET');
  }

  async issue(
    mobile: string,
    ipHash: string | null,
    purpose: OtpPurpose = 'login',
  ): Promise<OtpIssueResult> {
    const subject = this.subjectKey(mobile);
    const cooldown = this.config.get('OTP_RESEND_COOLDOWN_SECONDS');

    await this.enforce(
      `otp:cooldown:${subject}`,
      1,
      cooldown,
      'Please wait before requesting another code.',
    );
    await this.enforce(
      `otp:mobile:${subject}`,
      this.config.get('OTP_MAX_PER_MOBILE_PER_HOUR'),
      3600,
      'Too many codes requested for this number. Try again later.',
    );
    if (ipHash) {
      await this.enforce(
        `otp:ip:${ipHash}`,
        this.config.get('OTP_MAX_PER_IP_PER_HOUR'),
        3600,
        'Too many codes requested from this network. Try again later.',
      );
    }
    await this.enforce(
      'otp:global',
      this.config.get('OTP_GLOBAL_MAX_PER_MINUTE'),
      60,
      'Verification is temporarily busy. Try again in a minute.',
    );

    const code = generateOtp();
    const ttl = this.config.get('OTP_TTL_SECONDS');
    const key = this.codeKey(purpose, subject);
    // Overwrites (invalidates) any previously issued code for this number.
    await this.store.save(key, { hash: this.hashCode(purpose, mobile, code), attempts: 0 }, ttl);
    try {
      await this.provider.deliver(mobile, code, ttl);
    } catch (err) {
      await this.store.delete(key);
      throw err;
    }
    return {
      expiresIn: ttl,
      resendAfter: cooldown,
      ...(this.provider.exposesCodeForDevelopment ? { devOtp: code } : {}),
    };
  }

  /** Resolves when the code is correct; throws a domain error otherwise. The code is consumed on success. */
  async verify(mobile: string, code: string, purpose: OtpPurpose = 'login'): Promise<void> {
    if (!OTP_REGEX.test(code))
      throw new AppException(
        ErrorCode.INVALID_OTP,
        'Enter the 6-digit code.',
        HttpStatus.BAD_REQUEST,
      );
    const result = await this.store.attempt(
      this.codeKey(purpose, this.subjectKey(mobile)),
      this.hashCode(purpose, mobile, code),
      this.config.get('OTP_MAX_ATTEMPTS'),
    );
    switch (result.status) {
      case 'OK':
        return;
      case 'MISMATCH':
        throw new AppException(
          ErrorCode.INVALID_OTP,
          'That code is incorrect.',
          HttpStatus.BAD_REQUEST,
          { attemptsRemaining: result.attemptsRemaining },
        );
      case 'LOCKED':
        throw new AppException(
          ErrorCode.OTP_TOO_MANY_ATTEMPTS,
          'Too many incorrect attempts. Request a new code.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'EXPIRED':
        throw new AppException(
          ErrorCode.OTP_EXPIRED,
          'This code has expired. Request a new code.',
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  /** Keyed hash of the phone number, used in Redis keys and rate-limit buckets. */
  subjectKey(mobile: string): string {
    return createHmac('sha256', this.secret).update(`subject:${mobile}`).digest('hex').slice(0, 32);
  }

  private hashCode(purpose: OtpPurpose, mobile: string, code: string): string {
    return createHmac('sha256', this.secret).update(`${purpose}:${mobile}:${code}`).digest('hex');
  }

  private codeKey(purpose: OtpPurpose, subject: string): string {
    return `otp:code:${purpose}:${subject}`;
  }

  private async enforce(
    key: string,
    limit: number,
    windowSeconds: number,
    message: string,
  ): Promise<void> {
    const result = await this.limiter.hit(key, limit, windowSeconds);
    if (!result.allowed) {
      throw new AppException(ErrorCode.OTP_RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS, {
        retryAfter: result.retryAfter,
      });
    }
  }
}
