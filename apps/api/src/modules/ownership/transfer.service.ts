import { SecurityEventsService } from '../customer-security/security-events.service';
import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ActorType,
  ErrorCode,
  type PendingTransferDto,
  type TransferClaimPreviewResponse,
  type TransferClaimRegisterResponse,
  type TransferClaimResponse,
  type TransferCreatedResponse,
  normalizeTransferCode,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { isEmailUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
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
import { CustomerCredentialsService } from '../customer-auth/customer-credentials.service';
import { CustomerHelmetsService } from '../customer-helmets/customer-helmets.service';
import { assertOwnerAction } from '../helmet-lifecycle/domain/lifecycle-policy';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { OwnedHelmetLocker } from '../helmets/domain/owned-helmet.locker';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { generateTransferCode, hashTransferCode, sameHash } from './transfer-code';

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
 * Ownership transfer. The current owner (after a recent password check) gets a single-use,
 * short-lived code that is shown once; only its HMAC is stored. A recipient presents Helmet ID +
 * code and the claim runs in ONE transaction under row locks (helmet → active ownership →
 * transfer), so exactly one claim can ever succeed and no partial ownership state exists.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locker: OwnedHelmetLocker,
    private readonly statuses: HelmetStatusService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly recentAuth: RecentAuthService,
    private readonly lockout: LockoutService,
    private readonly limiter: RedisRateLimiter,
    private readonly accounts: CustomerAccountsService,
    private readonly credentials: CustomerCredentialsService,
    private readonly customerAuth: CustomerAuthService,
    private readonly customerHelmets: CustomerHelmetsService,
    private readonly config: AppConfigService,
    private readonly events: SecurityEventsService,
  ) {}

  // ───────────── Current owner ─────────────

  async create(
    customer: AuthenticatedCustomer,
    helmetId: string,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<TransferCreatedResponse> {
    await this.recentAuth.assert('customer', customer.id, customer.sessionId, recentAuthToken);
    const code = generateTransferCode();
    const expiresAt = new Date(Date.now() + this.config.get('TRANSFER_TOKEN_TTL_MINUTES') * 60_000);
    await this.prisma.$transaction(async (tx) => {
      const { helmet } = await this.locker.lockOwned(tx, helmetId, customer.id);
      assertOwnerAction(helmet.status, 'TRANSFER');
      // A new code always supersedes the previous one.
      await tx.helmetTransfer.updateMany({
        where: { helmetId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'SUPERSEDED' },
      });
      const transfer = await tx.helmetTransfer.create({
        data: { helmetId, fromUserId: customer.id, codeHash: this.hash(code), expiresAt },
      });
      // The code itself is never audited or logged.
      await this.audit.record(
        {
          action: AuditAction.TRANSFER_CREATED,
          entityType: 'helmet',
          entityId: helmetId,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { transferId: transfer.id, expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
    });
    return { transferCode: code, expiresAt: expiresAt.toISOString() };
  }

  async pending(customer: AuthenticatedCustomer, helmetId: string): Promise<PendingTransferDto> {
    await this.customerHelmets.get(customer.id, helmetId); // ownership check (404 otherwise)
    const t = await this.prisma.helmetTransfer.findFirst({
      where: {
        helmetId,
        fromUserId: customer.id,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      select: { expiresAt: true },
    });
    return { pending: t !== null, expiresAt: t?.expiresAt.toISOString() ?? null };
  }

  async cancel(
    customer: AuthenticatedCustomer,
    helmetId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.locker.lockOwned(tx, helmetId, customer.id);
      const id = await this.cancelPending(tx, helmetId, 'OWNER_CANCELLED', null);
      await this.audit.record(
        {
          action: AuditAction.TRANSFER_CANCELLED,
          entityType: 'helmet',
          entityId: helmetId,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { transferId: id, by: 'owner' },
        },
        tx,
      );
    });
  }

  /** Support cancels a pending transfer (e.g. the owner reports the code was shared by mistake). */
  async adminCancel(admin: AuthenticatedAdmin, helmetId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.locker.lock(tx, { id: helmetId });
      if (!locked) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
      const id = await this.cancelPending(tx, helmetId, 'ADMIN_CANCELLED', admin.id);
      await this.audit.record(
        {
          action: AuditAction.TRANSFER_CANCELLED,
          entityType: 'helmet',
          entityId: helmetId,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { transferId: id, by: 'admin' },
        },
        tx,
      );
    });
  }

  // ───────────── Recipient ─────────────

  /** Preliminary check before asking the recipient to sign in or create an account. */
  async preview(
    rawHelmetCode: string,
    rawCode: string,
    meta: RequestMeta,
  ): Promise<TransferClaimPreviewResponse> {
    const { helmetCode, code } = await this.begin(rawHelmetCode, rawCode, meta);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { helmet } = await this.verify(tx, helmetCode, code);
        const model = await tx.helmet.findUniqueOrThrow({
          where: { id: helmet.id },
          select: { helmetModel: { select: { name: true, brand: true } } },
        });
        return {
          helmet: {
            helmetCode: helmet.helmetCode,
            modelName: model.helmetModel.name,
            brand: model.helmetModel.brand,
          },
        };
      });
    } catch (err) {
      throw await this.onFailure(err, helmetCode, meta);
    }
  }

  /** A signed-in customer claims the helmet. */
  async claim(
    customer: AuthenticatedCustomer,
    rawHelmetCode: string,
    rawCode: string,
    meta: RequestMeta,
  ): Promise<TransferClaimResponse> {
    const { helmetCode, code } = await this.begin(rawHelmetCode, rawCode, meta);
    const { helmetId } = await this.execute(
      helmetCode,
      code,
      { kind: 'existing', userId: customer.id },
      meta,
    );
    return { helmet: await this.customerHelmets.get(customer.id, helmetId) };
  }

  /** A new customer claims the helmet: account (password + recovery code) created atomically. */
  async claimAsNewCustomer(
    rawHelmetCode: string,
    rawCode: string,
    email: string,
    password: string,
    name: string | undefined,
    meta: RequestMeta,
  ): Promise<{ result: TransferClaimRegisterResponse; session: CustomerSession }> {
    const { helmetCode, code } = await this.begin(rawHelmetCode, rawCode, meta);
    // Email + password policy and hashing before any lock is taken.
    const account = await this.accounts.prepare(password, { email, helmetCode, name });
    const { helmetId, userId } = await this.execute(
      helmetCode,
      code,
      { kind: 'new', account },
      meta,
    );
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const session = await this.customerAuth.startSession(user, meta);
    const helmet = await this.customerHelmets.get(userId, helmetId);
    return {
      result: { ...session.response, recoveryCode: account.recoveryCode, helmet },
      session,
    };
  }

  // ───────────── Internals ─────────────

  private async execute(
    helmetCode: string,
    code: string,
    recipient: Recipient,
    meta: RequestMeta,
  ): Promise<{ helmetId: string; userId: string }> {
    let outcome: { helmetId: string; userId: string; publicToken: string };
    try {
      outcome = await this.prisma.$transaction(
        async (tx) => {
          const { helmet, ownership, transfer } = await this.verify(tx, helmetCode, code);
          if (recipient.kind === 'existing' && recipient.userId === ownership.userId) {
            throw new AppException(
              ErrorCode.CANNOT_TRANSFER_TO_CURRENT_OWNER,
              'You already own this helmet.',
              HttpStatus.CONFLICT,
            );
          }
          const userId =
            recipient.kind === 'existing'
              ? recipient.userId
              : await this.accounts.create(tx, recipient.account, meta, 'transfer');
          const now = new Date();

          // 1. Close the previous ownership period (history is never overwritten).
          await tx.helmetOwnership.update({
            where: { id: ownership.id },
            data: {
              status: 'TRANSFERRED',
              transferredAt: now,
              endedAt: now,
              endReason: 'TRANSFER',
              transferId: transfer.id,
            },
          });
          // 2. Open the new one (the partial unique index guarantees a single ACTIVE row).
          await tx.helmetOwnership.create({
            data: {
              helmetId: helmet.id,
              userId,
              status: 'ACTIVE',
              acquiredVia: 'TRANSFER',
              activatedAt: now,
              transferId: transfer.id,
            },
          });
          // 3. Consume the code.
          await tx.helmetTransfer.update({
            where: { id: transfer.id },
            data: { status: 'CLAIMED', toUserId: userId, claimedAt: now },
          });
          // 4. The previous owner's switch is off for good; the new owner starts with none.
          await tx.helmetEmergencySetting.updateMany({
            where: { helmetId: helmet.id, userId: ownership.userId },
            data: { enabled: false },
          });
          // 5. Never ACTIVE after a transfer: the new owner must review and enable explicitly.
          if (helmet.status === 'ACTIVE') {
            await this.statuses.apply(tx, {
              helmetId: helmet.id,
              from: 'ACTIVE',
              to: 'ACTIVATED',
              actor: { type: ActorType.SYSTEM, id: userId },
              reason: 'Ownership transferred',
              reasonCode: 'TRANSFERRED',
            });
          }
          await this.audit.record(
            {
              action: AuditAction.TRANSFER_CLAIMED,
              entityType: 'helmet',
              entityId: helmet.id,
              userId,
              ipHash: meta.ipHash,
              metadata: {
                transferId: transfer.id,
                fromUserId: ownership.userId,
                toUserId: userId,
                newAccount: recipient.kind === 'new',
              },
            },
            tx,
          );
          await this.events.record(ownership.userId, 'HELMET_TRANSFERRED_OUT', {}, tx);
          await this.events.record(userId, 'HELMET_RECEIVED', meta, tx);
          return { helmetId: helmet.id, userId, publicToken: helmet.publicToken };
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (err) {
      throw await this.onFailure(err, helmetCode, meta);
    }
    await this.lockout.reset(this.lockKey(helmetCode));
    // Safety-critical: the previous owner's public data must disappear immediately.
    await this.cache.invalidate(outcome.publicToken);
    return { helmetId: outcome.helmetId, userId: outcome.userId };
  }

  /**
   * Inside a transaction: locks helmet → ownership → transfer and validates the code. Errors for
   * unknown helmets and wrong codes are identical; "expired"/"already used" are revealed only to
   * someone who knows the correct code.
   */
  private async verify(tx: PrismaTx, helmetCode: string, code: string) {
    const locked = await this.locker.lock(tx, { helmetCode });
    const codeHash = this.hash(code);
    const rows = locked
      ? await tx.$queryRaw<TransferRow[]>`
          SELECT id, from_user_id, status, code_hash, expires_at FROM helmet_transfers
          WHERE helmet_id = ${locked.helmet.id}::uuid AND code_hash = ${codeHash}
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`
      : [];
    const transfer = rows[0];
    if (!locked || !transfer || !sameHash(transfer.code_hash, codeHash)) throw this.invalid();
    if (transfer.status === 'CLAIMED') {
      throw new TransferCodeFailure(
        ErrorCode.TRANSFER_ALREADY_USED,
        'This transfer code has already been used.',
        HttpStatus.CONFLICT,
      );
    }
    if (transfer.status !== 'PENDING') throw this.invalid();
    if (transfer.expires_at.getTime() <= Date.now()) {
      throw new TransferCodeFailure(
        ErrorCode.TRANSFER_CODE_EXPIRED,
        'This transfer code has expired. Ask the owner for a new one.',
        HttpStatus.GONE,
      );
    }
    const { helmet, ownership } = locked;
    // The offer is only valid while its creator still owns the helmet.
    if (!ownership || ownership.userId !== transfer.from_user_id) throw this.invalid();
    assertOwnerAction(helmet.status, 'TRANSFER');
    return { helmet, ownership, transfer };
  }

  /** Validates input format and the attempt budgets before any database work. */
  private async begin(
    rawHelmetCode: string,
    rawCode: string,
    meta: RequestMeta,
  ): Promise<{ helmetCode: string; code: string }> {
    const helmetCode = this.credentials.canonicalHelmetCode(rawHelmetCode);
    const [state, ip] = await Promise.all([
      this.lockout.status(this.lockKey(helmetCode)),
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
      await this.recordFailure(helmetCode, meta);
      throw this.invalid();
    }
    return { helmetCode, code };
  }

  /** Counts code failures (escalating per-helmet lock + per-IP budget); never records the code. */
  private async onFailure(err: unknown, helmetCode: string, meta: RequestMeta): Promise<unknown> {
    if (isEmailUniqueViolation(err)) return this.accounts.emailTaken();
    if (!(err instanceof TransferCodeFailure)) return err;
    const locked = await this.recordFailure(helmetCode, meta);
    return locked ? this.attemptsExceeded(locked) : err;
  }

  private async recordFailure(helmetCode: string, meta: RequestMeta): Promise<number | null> {
    const state = await this.lockout.fail(this.lockKey(helmetCode), {
      threshold: this.config.get('TRANSFER_FAILURES_BEFORE_LOCK'),
      baseSeconds: this.config.get('TRANSFER_LOCKOUT_BASE_SECONDS'),
      maxSeconds: 86_400,
    });
    if (meta.ipHash) {
      await this.limiter.hit(
        `transfer-claim:ip:${meta.ipHash}`,
        this.config.get('TRANSFER_MAX_FAILURES_PER_IP_PER_HOUR'),
        HOUR,
      );
    }
    await this.audit.recordSafe({
      action: state.locked ? AuditAction.TRANSFER_CLAIM_LOCKED : AuditAction.TRANSFER_CLAIM_FAILED,
      entityType: 'helmet_code',
      entityId: sha(helmetCode).slice(0, 32),
      ipHash: meta.ipHash,
      metadata: { failures: state.failures },
    });
    return state.locked ? state.retryAfter : null;
  }

  private async cancelPending(
    tx: PrismaTx,
    helmetId: string,
    reason: string,
    adminId: string | null,
  ): Promise<string> {
    const pending = await tx.helmetTransfer.findFirst({
      where: { helmetId, status: 'PENDING' },
      select: { id: true },
    });
    if (!pending) {
      throw AppException.notFound(ErrorCode.TRANSFER_NOT_FOUND, 'There is no pending transfer.');
    }
    await tx.helmetTransfer.update({
      where: { id: pending.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason,
        cancelledByAdminId: adminId,
      },
    });
    return pending.id;
  }

  private hash(code: string): string {
    return hashTransferCode(this.config.get('CUSTOMER_CREDENTIAL_PEPPER'), code);
  }

  private lockKey(helmetCode: string): string {
    return `transfer-claim:helmet:${sha(helmetCode)}`;
  }

  private invalid(): TransferCodeFailure {
    return new TransferCodeFailure(
      ErrorCode.TRANSFER_CODE_INVALID,
      'The Helmet ID or transfer code is incorrect.',
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
