import { HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode, normalizeEmail, type NormalizedEmail } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { normalizePhone } from '../../common/utils/phone';
import type { RequestMeta } from '../../common/utils/request-context';
import type { PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { generateCustomerCode } from '../../security/helmet-identity.generator';
import { uuidv7 } from '../../security/uuid';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { CustomerCredentialsService } from './customer-credentials.service';
import { EmailOtpService } from './email-otp.service';

/** Hashed credentials for an account about to be created; `recoveryCode` is shown once. */
export interface PreparedAccount {
  passwordHash: string;
  recoveryCodeHash: string;
  recoveryCode: string;
  email: NormalizedEmail;
  /** E.164 (`+919876543210`). Contact detail for the owner; not verified, never a sign-in. */
  mobile: string;
  name?: string;
  /** The address was proven with an emailed code before the account was created. */
  emailVerified: boolean;
}

const EMAIL_TAKEN_MESSAGE =
  'An account already uses this email. Sign in to add this helmet, or use a different email.';

/**
 * The single way a customer account is created (first activation, transfer claim by a new
 * customer). Hashing is split from the insert so it runs before any row lock is taken.
 */
@Injectable()
export class CustomerAccountsService {
  constructor(
    private readonly credentials: CustomerCredentialsService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly emailOtp: EmailOtpService,
  ) {}

  /** Validates and canonicalises an email; throws INVALID_EMAIL (400). */
  parseEmail(raw: string): NormalizedEmail {
    const email = normalizeEmail(raw);
    if (!email) {
      throw new AppException(
        ErrorCode.INVALID_EMAIL,
        'Enter a valid email address.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return email;
  }

  /** Validates a mobile number and returns it in E.164; throws INVALID_PHONE_NUMBER (400). */
  parseMobile(raw: string): string {
    const mobile = normalizePhone(raw, this.config.get('DEFAULT_PHONE_REGION'));
    if (!mobile) {
      throw new AppException(
        ErrorCode.INVALID_PHONE_NUMBER,
        'Enter a valid mobile number.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return mobile;
  }

  /**
   * Throws EMAIL_ALREADY_REGISTERED (409) when a live account other than `exceptUserId` uses
   * the address. The partial unique index remains the final guarantee under races.
   */
  async assertEmailAvailable(
    tx: PrismaTx,
    email: NormalizedEmail,
    exceptUserId?: string,
  ): Promise<void> {
    const holder = await tx.user.findFirst({
      where: { emailNormalized: email.normalized, status: { not: 'DELETED' } },
      select: { id: true },
    });
    if (holder && holder.id !== exceptUserId) throw this.emailTaken();
  }

  emailTaken(): AppException {
    return new AppException(
      ErrorCode.EMAIL_ALREADY_REGISTERED,
      EMAIL_TAKEN_MESSAGE,
      HttpStatus.CONFLICT,
    );
  }

  /**
   * Validates the email (and its verification proof when EMAIL_VERIFICATION_REQUIRED) and the
   * password policy, then hashes the password and a fresh recovery code. The activation PIN
   * stays the proof of possessing the Safety ID; the email proof shows the address is real.
   */
  async prepare(
    password: string,
    context: {
      email: string;
      mobile: string;
      helmetCode?: string;
      activationPin?: string;
      name?: string;
      emailProof?: string;
    },
  ): Promise<PreparedAccount> {
    const email = this.parseEmail(context.email);
    const mobile = this.parseMobile(context.mobile);
    const emailVerified = await this.emailOtp.checkProof(context.emailProof, email);
    if (!emailVerified && this.config.get('EMAIL_VERIFICATION_REQUIRED'))
      throw new AppException(
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Verify your email with the code we send you, then try again.',
        HttpStatus.BAD_REQUEST,
      );
    this.credentials.assertAcceptablePassword(password, { ...context, email: email.email });
    const [passwordHash, recovery] = await Promise.all([
      this.credentials.hashPassword(password),
      this.credentials.newRecoveryCode(),
    ]);
    return {
      passwordHash,
      recoveryCodeHash: recovery.hash,
      recoveryCode: recovery.code,
      email,
      mobile,
      name: context.name,
      emailVerified,
    };
  }

  /**
   * Inserts the account inside the caller's transaction and audits it. Returns the user id.
   * Throws EMAIL_ALREADY_REGISTERED before any write when the email is taken, so the caller's
   * transaction (PIN consumption, ownership) rolls back cleanly.
   */
  async create(
    tx: PrismaTx,
    account: PreparedAccount,
    meta: RequestMeta,
    via: 'activation' | 'transfer',
  ): Promise<string> {
    await this.assertEmailAvailable(tx, account.email);
    const id = uuidv7();
    const now = new Date();
    const customerCode = await this.freeCustomerCode(tx);
    await tx.user.create({
      data: {
        id,
        customerCode,
        name: account.name,
        email: account.email.email,
        emailNormalized: account.email.normalized,
        emailVerified: account.emailVerified,
        mobile: account.mobile,
        mobileVerified: false,
        passwordHash: account.passwordHash,
        passwordChangedAt: now,
        recoveryCodeHash: account.recoveryCodeHash,
        recoveryCodeCreatedAt: now,
      },
    });
    await this.audit.record(
      {
        action: AuditAction.CUSTOMER_CREATED,
        entityType: 'user',
        entityId: id,
        userId: id,
        ipHash: meta.ipHash,
        metadata: { via, customerId: customerCode },
      },
      tx,
    );
    return id;
  }

  /**
   * A Customer ID not yet in use. ~34.7 random bits make a collision astronomically unlikely;
   * the check avoids aborting the surrounding activation/transfer transaction on the unique
   * index (which remains the final guarantee).
   */
  private async freeCustomerCode(tx: PrismaTx): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = generateCustomerCode();
      if (!(await tx.user.findUnique({ where: { customerCode: code }, select: { id: true } })))
        return code;
    }
    throw new Error('Could not allocate a unique Customer ID');
  }
}
