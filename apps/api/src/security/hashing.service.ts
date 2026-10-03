import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfigService } from '../config/app-config.service';

/**
 * Argon2id hashing for low-entropy secrets (passwords, activation PINs) and SHA-256 for
 * high-entropy opaque tokens (refresh tokens), where a slow KDF adds cost but no security.
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

  constructor(config: AppConfigService) {
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

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, this.passwordOptions);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Customer passwords and recovery codes: Argon2id (password-strength parameters) with a
   * dedicated server-side pepper, so a database dump alone is not enough to attack them.
   */
  hashCustomerSecret(secret: string): Promise<string> {
    return argon2.hash(secret, { ...this.passwordOptions, secret: this.customerPepper });
  }

  async verifyCustomerSecret(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret, { secret: this.customerPepper });
    } catch {
      return false;
    }
  }

  /** Activation PINs are hashed with a server-side pepper so a DB leak alone is insufficient. */
  hashPin(pin: string): Promise<string> {
    return argon2.hash(pin, this.pinOptions);
  }

  async verifyPin(hash: string, pin: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, pin, { secret: this.pepper });
    } catch {
      return false;
    }
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
