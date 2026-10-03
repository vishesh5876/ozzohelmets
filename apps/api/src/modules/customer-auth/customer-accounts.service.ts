import { Injectable } from '@nestjs/common';
import type { RequestMeta } from '../../common/utils/request-context';
import type { PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { uuidv7 } from '../../security/uuid';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { CustomerCredentialsService } from './customer-credentials.service';

/** Hashed credentials for an account about to be created; `recoveryCode` is shown once. */
export interface PreparedAccount {
  passwordHash: string;
  recoveryCodeHash: string;
  recoveryCode: string;
  name?: string;
}

/**
 * The single way a customer account is created (first activation, transfer claim by a new
 * customer). Hashing is split from the insert so it runs before any row lock is taken.
 */
@Injectable()
export class CustomerAccountsService {
  constructor(
    private readonly credentials: CustomerCredentialsService,
    private readonly audit: AuditService,
  ) {}

  /** Validates the password policy, then hashes it and a fresh recovery code. */
  async prepare(
    password: string,
    context: { helmetCode?: string; activationPin?: string; name?: string },
  ): Promise<PreparedAccount> {
    this.credentials.assertAcceptablePassword(password, context);
    const [passwordHash, recovery] = await Promise.all([
      this.credentials.hashPassword(password),
      this.credentials.newRecoveryCode(),
    ]);
    return {
      passwordHash,
      recoveryCodeHash: recovery.hash,
      recoveryCode: recovery.code,
      name: context.name,
    };
  }

  /** Inserts the account inside the caller's transaction and audits it. Returns the user id. */
  async create(
    tx: PrismaTx,
    account: PreparedAccount,
    meta: RequestMeta,
    via: 'activation' | 'transfer',
  ): Promise<string> {
    const id = uuidv7();
    const now = new Date();
    await tx.user.create({
      data: {
        id,
        name: account.name,
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
        metadata: { via },
      },
      tx,
    );
    return id;
  }
}
