import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode, isValidHelmetCode, normalizeHelmetCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { HashingService } from '../../security/hashing.service';
import { passwordProblem } from '../../security/password-policy';
import { generateRecoveryCode } from '../../security/recovery-code';

/** Password + recovery-code primitives shared by activation (registration) and auth. */
@Injectable()
export class CustomerCredentialsService {
  constructor(private readonly hashing: HashingService) {}

  /** Throws WEAK_PASSWORD with a user-facing reason; never logs the password. */
  assertAcceptablePassword(
    password: string,
    context: { helmetCode?: string; activationPin?: string; email?: string } = {},
  ): void {
    const problem =
      passwordProblem(password, { helmetCode: context.helmetCode }) ??
      (context.activationPin &&
      password.trim().toUpperCase().replace(/[\s-]/g, '') === context.activationPin
        ? 'Don’t reuse the activation PIN as your password.'
        : null) ??
      (context.email && password.trim().toLowerCase() === context.email.toLowerCase()
        ? 'Don’t use your email address as your password.'
        : null);
    if (problem) throw new AppException(ErrorCode.WEAK_PASSWORD, problem, HttpStatus.BAD_REQUEST);
  }

  hashPassword(password: string): Promise<string> {
    return this.hashing.hashCustomerSecret(password);
  }

  verifyPassword(hash: string | null, password: string): Promise<boolean> {
    // A dummy verification keeps timing similar when there is no account/hash.
    return hash ? this.hashing.verifyCustomerSecret(hash, password) : this.dummyVerify(password);
  }

  /** New offline recovery code: plaintext for one-time display + its peppered Argon2id hash. */
  async newRecoveryCode(): Promise<{ code: string; hash: string }> {
    const code = generateRecoveryCode();
    return { code, hash: await this.hashing.hashCustomerSecret(code) };
  }

  verifyRecoveryCode(hash: string | null, code: string): Promise<boolean> {
    return hash ? this.hashing.verifyCustomerSecret(hash, code) : this.dummyVerify(code);
  }

  /** Canonical Helmet ID or a VALIDATION_ERROR (checksum checked before any lookup). */
  canonicalHelmetCode(input: string): string {
    const code = normalizeHelmetCode(input);
    if (!code || !isValidHelmetCode(code)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'That Helmet ID is not valid. Check the characters on your label.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return code;
  }

  private dummyHash: Promise<string> | null = null;

  private async dummyVerify(secret: string): Promise<false> {
    this.dummyHash ??= this.hashing.hashCustomerSecret('timing-equaliser-not-a-real-secret');
    await this.hashing.verifyCustomerSecret(await this.dummyHash, secret);
    return false;
  }
}
