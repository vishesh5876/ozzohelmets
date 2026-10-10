import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ErrorCode } from '@helmet/types';
import { AppException } from '../common/http/app.exception';
import { AppConfigService } from '../config/app-config.service';
import { metrics } from '../infrastructure/metrics/metrics';
import { ConcurrencyLimitExceeded, ConcurrencyLimiter } from './concurrency-limiter';

/**
 * Argon2id hashing for low-entropy secrets (passwords, activation PINs) and SHA-256 for
 * high-entropy opaque tokens (refresh tokens), where a slow KDF adds cost but no security.
 *
 * Phase 7: Argon2 runs on libuv threads and can consume the whole CPU quota of the container,
 * starving the event loop that serves public emergency pages. A semaphore caps concurrent
 * Argon2 operations (ARGON2_MAX_CONCURRENCY); interactive callers queue up to ARGON2_MAX_QUEUE
 * and are then refused with 503 (retry shortly), background work (batch PIN generation) waits.
 */
@Injectable()
export class HashingService {
  private readonly pepper: Buffer;
  private readonly customerPepper: Buffer;
  private readonly pinOptions: argon2.Options;
  /** OWASP-recommended baseline for interactive password hashing. */
  private readonly passwordOptions: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  };

  private readonly limiter: ConcurrencyLimiter;

  constructor(config: AppConfigService) {
    this.limiter = new ConcurrencyLimiter(
      config.get('ARGON2_MAX_CONCURRENCY'),
      config.get('ARGON2_MAX_QUEUE'),
    );
    this.pepper = Buffer.from(config.get('PIN_HASH_PEPPER'), 'utf8');
    this.customerPepper = Buffer.from(config.get('CUSTOMER_CREDENTIAL_PEPPER'), 'utf8');
    this.pinOptions = {
      type: argon2.argon2id,
      memoryCost: config.get('PIN_ARGON2_MEMORY_KIB'),
      timeCost: config.get('PIN_ARGON2_TIME_COST'),
      parallelism: 1,
      secret: this.pepper,
    };
  }

  /** Runs one Argon2 operation under the concurrency cap. */
  private async limited<T>(fn: () => Promise<T>, bounded = true): Promise<T> {
    try {
      return await this.limiter.run(fn, { bounded });
    } catch (err) {
      if (!(err instanceof ConcurrencyLimitExceeded)) throw err;
      metrics.passwordHashRejected.inc();
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'The service is busy. Please try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /** Verification helper: a malformed hash is "no match", but a busy refusal propagates. */
  private async verifyLimited(fn: () => Promise<boolean>): Promise<boolean> {
    return this.limited(async () => {
      try {
        return await fn();
      } catch {
        return false;
      }
    });
  }

  hashPassword(password: string): Promise<string> {
    return this.limited(() => argon2.hash(password, this.passwordOptions));
  }

  verifyPassword(hash: string, password: string): Promise<boolean> {
    return this.verifyLimited(() => argon2.verify(hash, password));
  }

  /**
   * Customer passwords and recovery codes: Argon2id (password-strength parameters) with a
   * dedicated server-side pepper, so a database dump alone is not enough to attack them.
   */
  hashCustomerSecret(secret: string): Promise<string> {
    return this.limited(() =>
      argon2.hash(secret, { ...this.passwordOptions, secret: this.customerPepper }),
    );
  }

  verifyCustomerSecret(hash: string, secret: string): Promise<boolean> {
    return this.verifyLimited(() => argon2.verify(hash, secret, { secret: this.customerPepper }));
  }

  /**
   * Activation PINs are hashed with a server-side pepper so a DB leak alone is insufficient.
   * Hashing happens during batch generation (background): it waits for a slot, never refused.
   */
  hashPin(pin: string): Promise<string> {
    return this.limited(() => argon2.hash(pin, this.pinOptions), false);
  }

  verifyPin(hash: string, pin: string): Promise<boolean> {
    return this.verifyLimited(() => argon2.verify(hash, pin, { secret: this.pepper }));
  }

  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  safeEqualHex(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
