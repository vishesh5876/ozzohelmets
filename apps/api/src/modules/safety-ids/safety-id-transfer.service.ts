import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CustomerSafetyIdDto,
  ErrorCode,
  isValidSafetyCode,
  normalizeSafetyCode,
  normalizeTransferCode,
  type RecoveryCodeIssued,
  SAFETY_ID_IN_USE,
  type SafetyIdTransferStartResponse,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isEmailUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { LockoutService } from '../../security/lockout';
import { RecentAuthService } from '../../security/recent-auth.service';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import {
  CustomerAccountsService,
  type PreparedAccount,
} from '../customer-auth/customer-accounts.service';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CustomerAuthService, type CustomerSession } from '../customer-auth/customer-auth.service';
import { SecurityEventsService } from '../customer-security/security-events.service';
import { generateTransferCode, hashTransferCode, sameHash } from '../ownership/transfer-code';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { CustomerSafetyIdsService } from './customer-safety-ids.service';
import { SafetyIdCoreService } from './domain/safety-id-core.service';

const HOUR = 3600;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** A wrong/unknown/used/expired code: counted against the attempt budgets after rollback. */
class TransferCodeFailure extends AppException {}

type Recipient = { kind: 'existing'; userId: string } | { kind: 'new'; account: PreparedAccount };

interface TransferRow {
  id: string;
  from_user_id: string;
  status: 'PENDING' | 'CLAIMED' | 'CANCELLED' | 'EXPIRED';
  code_hash: string;
  expires_at: Date;
}

/**
 * Transfer of a STANDALONE Safety ID (a sticker or card with no linked helmet). Same model as the
 * helmet transfer: a single-use, short-lived Transfer Code shown once (only its HMAC is stored),
 * claimed in ONE transaction under row locks. The new owner starts with sharing off. A linked
 * Safety ID moves with its helmet's transfer instead and cannot be transferred alone.
 */
@Injectable()
export class SafetyIdTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: SafetyIdCoreService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly recentAuth: RecentAuthService,
    private readonly lockout: LockoutService,
    private readonly limiter: RedisRateLimiter,
    private readonly accounts: CustomerAccountsService,
    private readonly customerAuth: CustomerAuthService,
    private readonly safetyIds: CustomerSafetyIdsService,
    private readonly config: AppConfigService,
    private readonly events: SecurityEventsService,
  ) {}

  async create(
    customer: AuthenticatedCustomer,
    safetyId: string,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<SafetyIdTransferStartResponse> {
    await this.recentAuth.assert('customer', customer.id, customer.sessionId, recentAuthToken);
    const code = generateTransferCode();
    const expiresAt = new Date(Date.now() + this.config.get('TRANSFER_TOKEN_TTL_MINUTES') * 60_000);
    await this.prisma.$transaction(async (tx) => {
      const state = await this.core.lockOwned(tx, safetyId, customer.id);
      this.assertTransferable(state.safetyId.status, state.helmet !== null);
      await tx.safetyIdTransfer.updateMany({
        where: { safetyId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'SUPERSEDED' },
      });
      const transfer = await tx.safetyIdTransfer.create({
        data: { safetyId, fromUserId: customer.id, codeHash: this.hash(code), expiresAt },
      });
      // The code itself is never audited or logged.
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_TRANSFER_CREATED,
          entityType: 'safety_id',
          entityId: safetyId,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { transferId: transfer.id, expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
    });
    return { transferCode: code, expiresAt: expiresAt.toISOString() };
  }

  async cancel(
    customer: AuthenticatedCustomer,
    safetyId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.core.lockOwned(tx, safetyId, customer.id);
      const id = await this.cancelPending(tx, safetyId, 'OWNER_CANCELLED');
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_TRANSFER_CANCELLED,
          entityType: 'safety_id',
          entityId: safetyId,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { transferId: id, by: 'owner' },
        },
        tx,
      );
    });
  }

  async adminCancel(admin: AuthenticatedAdmin, safetyId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const state = await this.core.lock(tx, { id: safetyId });
      if (!state)
        throw AppException.notFound(ErrorCode.SAFETY_ID_NOT_FOUND, 'Safety ID not found.');
      const id = await this.cancelPending(tx, safetyId, 'ADMIN_CANCELLED');
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_TRANSFER_CANCELLED,
          entityType: 'safety_id',
          entityId: safetyId,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { transferId: id, by: 'admin' },
        },
        tx,
      );
    });
  }

  /** A signed-in customer claims the Safety ID. */
  async claim(
    customer: AuthenticatedCustomer,
    rawSafetyCode: string,
    rawCode: string,
    meta: RequestMeta,
  ): Promise<{ safetyId: CustomerSafetyIdDto }> {
    const { safetyCode, code } = await this.begin(rawSafetyCode, rawCode, meta);
    const { safetyId } = await this.execute(
      safetyCode,
      code,
      { kind: 'existing', userId: customer.id },
      meta,
    );
    return { safetyId: await this.safetyIds.get(customer.id, safetyId) };
  }

  /** A new customer claims the Safety ID: account (password + recovery code) created atomically. */
  async claimAsNewCustomer(
    rawSafetyCode: string,
    rawCode: string,
    email: string,
    mobile: string,
    password: string,
    name: string | undefined,
    meta: RequestMeta,
  ): Promise<{
    result: CustomerSession['response'] & RecoveryCodeIssued & { safetyId: CustomerSafetyIdDto };
    session: CustomerSession;
  }> {
    const { safetyCode, code } = await this.begin(rawSafetyCode, rawCode, meta);
    const account = await this.accounts.prepare(password, {
      email,
      mobile,
      helmetCode: safetyCode,
      name,
    });
    const { safetyId, userId } = await this.execute(
      safetyCode,
      code,
      { kind: 'new', account },
      meta,
    );
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const session = await this.customerAuth.startSession(user, meta);
    return {
      result: {
        ...session.response,
        recoveryCode: account.recoveryCode,
        safetyId: await this.safetyIds.get(userId, safetyId),
      },
      session,
    };
  }

  private async execute(
    safetyCode: string,
    code: string,
    recipient: Recipient,
    meta: RequestMeta,
  ): Promise<{ safetyId: string; userId: string }> {
    let outcome: { safetyId: string; userId: string; publicToken: string };
    try {
      outcome = await this.prisma.$transaction(
        async (tx) => {
          const { state, transfer } = await this.verify(tx, safetyCode, code);
          const fromUserId = state.ownership!.userId;
          if (recipient.kind === 'existing' && recipient.userId === fromUserId)
            throw new AppException(
              ErrorCode.CANNOT_TRANSFER_TO_CURRENT_OWNER,
              'You already own this Safety ID.',
              HttpStatus.CONFLICT,
            );
          const userId =
            recipient.kind === 'existing'
              ? recipient.userId
              : await this.accounts.create(tx, recipient.account, meta, 'transfer');
          const now = new Date();
          // Previous owner's period ends (sharing off, ACTIVE → ACTIVATED); new owner starts off.
          await this.core.endOwnership(tx, state.safetyId.id, 'TRANSFERRED', 'TRANSFER', now);
          await this.core.startOwnership(
            tx,
            state.safetyId.id,
            userId,
            'TRANSFER',
            now,
            transfer.id,
          );
          await tx.safetyIdTransfer.update({
            where: { id: transfer.id },
            data: { status: 'CLAIMED', toUserId: userId, claimedAt: now },
          });
          await this.audit.record(
            {
              action: AuditAction.SAFETY_ID_TRANSFER_CLAIMED,
              entityType: 'safety_id',
              entityId: state.safetyId.id,
              userId,
              ipHash: meta.ipHash,
              metadata: {
                transferId: transfer.id,
                fromUserId,
                toUserId: userId,
                newAccount: recipient.kind === 'new',
              },
            },
            tx,
          );
          await this.events.record(fromUserId, 'SAFETY_ID_TRANSFERRED_OUT', {}, tx);
          await this.events.record(userId, 'SAFETY_ID_RECEIVED', meta, tx);
          return { safetyId: state.safetyId.id, userId, publicToken: state.safetyId.publicToken };
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (err) {
      throw await this.onFailure(err, safetyCode, meta);
    }
    await this.lockout.reset(this.lockKey(safetyCode));
    // Safety-critical: the previous owner's public data must disappear immediately.
    await this.cache.invalidate(outcome.publicToken);
    return { safetyId: outcome.safetyId, userId: outcome.userId };
  }

  /**
   * Locks Safety ID → ownership → transfer and validates the code. Unknown Safety IDs and wrong
   * codes give identical errors; "expired"/"already used" only to someone with the right code.
   */
  private async verify(tx: PrismaTx, safetyCode: string, code: string) {
    const state = await this.core.lock(tx, { safetyCode });
    const codeHash = this.hash(code);
    const rows = state
      ? await tx.$queryRaw<TransferRow[]>`
          SELECT id, from_user_id, status, code_hash, expires_at FROM safety_id_transfers
          WHERE safety_id = ${state.safetyId.id}::uuid AND code_hash = ${codeHash}
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`
      : [];
    const transfer = rows[0];
    if (!state || !transfer || !sameHash(transfer.code_hash, codeHash)) throw this.invalid();
    if (transfer.status === 'CLAIMED')
      throw new TransferCodeFailure(
        ErrorCode.TRANSFER_ALREADY_USED,
        'This Transfer Code has already been used.',
        HttpStatus.CONFLICT,
      );
    if (transfer.status !== 'PENDING') throw this.invalid();
    if (transfer.expires_at.getTime() <= Date.now())
      throw new TransferCodeFailure(
        ErrorCode.TRANSFER_CODE_EXPIRED,
        'This Transfer Code has expired. Ask the owner for a new one.',
        HttpStatus.GONE,
      );
    // The offer is only valid while its creator still owns the Safety ID.
    if (!state.ownership || state.ownership.userId !== transfer.from_user_id) throw this.invalid();
    this.assertTransferable(state.safetyId.status, state.helmet !== null);
    return { state, transfer };
  }

  private assertTransferable(status: string, linked: boolean): void {
    if (linked)
      throw new AppException(
        ErrorCode.SAFETY_ID_NOT_TRANSFERABLE,
        'This Safety ID is linked to a helmet and moves with it. Transfer the helmet instead.',
        HttpStatus.CONFLICT,
      );
    if (!SAFETY_ID_IN_USE.includes(status as never))
      throw new AppException(
        ErrorCode.SAFETY_ID_NOT_TRANSFERABLE,
        'Only an active Safety ID can be transferred.',
        HttpStatus.CONFLICT,
        { status },
      );
  }

  private async begin(
    rawSafetyCode: string,
    rawCode: string,
    meta: RequestMeta,
  ): Promise<{ safetyCode: string; code: string }> {
    const safetyCode = normalizeSafetyCode(rawSafetyCode);
    if (!safetyCode || !isValidSafetyCode(safetyCode))
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'That Safety ID is not valid. Check the characters printed next to the QR code.',
        HttpStatus.BAD_REQUEST,
      );
    const [state, ip] = await Promise.all([
      this.lockout.status(this.lockKey(safetyCode)),
      meta.ipHash
        ? this.limiter.peek(
            `transfer-claim:ip:${meta.ipHash}`,
            this.config.get('TRANSFER_MAX_FAILURES_PER_IP_PER_HOUR'),
          )
        : Promise.resolve(null),
    ]);
    if (state.locked) throw this.attemptsExceeded(state.retryAfter);
    if (ip && !ip.allowed) throw this.attemptsExceeded(ip.retryAfter);
    const code = normalizeTransferCode(rawCode);
    if (!code) {
      await this.recordFailure(safetyCode, meta);
      throw this.invalid();
    }
    return { safetyCode, code };
  }

  private async onFailure(err: unknown, safetyCode: string, meta: RequestMeta): Promise<unknown> {
    if (isEmailUniqueViolation(err)) return this.accounts.emailTaken();
    if (!(err instanceof TransferCodeFailure)) return err;
    const locked = await this.recordFailure(safetyCode, meta);
    return locked ? this.attemptsExceeded(locked) : err;
  }

  private async recordFailure(safetyCode: string, meta: RequestMeta): Promise<number | null> {
    const state = await this.lockout.fail(this.lockKey(safetyCode), {
      threshold: this.config.get('TRANSFER_FAILURES_BEFORE_LOCK'),
      baseSeconds: this.config.get('TRANSFER_LOCKOUT_BASE_SECONDS'),
      maxSeconds: 86_400,
    });
    if (meta.ipHash)
      await this.limiter.hit(
        `transfer-claim:ip:${meta.ipHash}`,
        this.config.get('TRANSFER_MAX_FAILURES_PER_IP_PER_HOUR'),
        HOUR,
      );
    await this.audit.recordSafe({
      action: AuditAction.SAFETY_ID_TRANSFER_CLAIM_FAILED,
      entityType: 'safety_code',
      entityId: sha(safetyCode).slice(0, 32),
      ipHash: meta.ipHash,
      metadata: { failures: state.failures, locked: state.locked },
    });
    return state.locked ? state.retryAfter : null;
  }

  private async cancelPending(tx: PrismaTx, safetyId: string, reason: string): Promise<string> {
    const pending = await tx.safetyIdTransfer.findFirst({
      where: { safetyId, status: 'PENDING' },
      select: { id: true },
    });
    if (!pending)
      throw AppException.notFound(ErrorCode.TRANSFER_NOT_FOUND, 'There is no pending transfer.');
    await tx.safetyIdTransfer.update({
      where: { id: pending.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
    });
    return pending.id;
  }

  /** Domain-separated from helmet Transfer Codes (same HMAC key, different message prefix). */
  private hash(code: string): string {
    return hashTransferCode(this.config.get('CUSTOMER_CREDENTIAL_PEPPER'), `safety-id:${code}`);
  }

  private lockKey(safetyCode: string): string {
    return `transfer-claim:safety-id:${sha(safetyCode)}`;
  }

  private invalid(): TransferCodeFailure {
    return new TransferCodeFailure(
      ErrorCode.TRANSFER_CODE_INVALID,
      'The Safety ID or Transfer Code is incorrect.',
      HttpStatus.BAD_REQUEST,
    );
  }

  private attemptsExceeded(retryAfter: number): AppException {
    return new AppException(
      ErrorCode.TRANSFER_ATTEMPTS_EXCEEDED,
      'Too many incorrect attempts. Please wait before trying again.',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfter },
    );
  }
}
