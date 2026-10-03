import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACTIVATION_PIN_ALPHABET,
  ACTIVATION_PIN_LENGTH,
  type ActivationAddHelmetResponse,
  type ActivationRegisterResponse,
  type ActivationValidateResponse,
  ActorType,
  ErrorCode,
  isValidPublicToken,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { HashingService } from '../../security/hashing.service';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { uuidv7 } from '../../security/uuid';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CustomerAuthService } from '../customer-auth/customer-auth.service';
import { CustomerCredentialsService } from '../customer-auth/customer-credentials.service';
import { CustomerHelmetsService } from '../customer-helmets/customer-helmets.service';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { ActivationPolicy } from './domain/activation-policy';
import type {
  ActivationPinDto,
  ActivationTargetDto,
  RegisterActivationDto,
} from './dto/activation.dto';

const PIN_REGEX = new RegExp(`^[${ACTIVATION_PIN_ALPHABET}]{${ACTIVATION_PIN_LENGTH}}$`);
const HOUR = 3600;

interface LockedHelmet {
  id: string;
  helmet_code: string;
  status: ActivationAddHelmetResponse['helmet']['status'];
  activation_pin_used: boolean;
  activation_pin_hash: string;
  activation_attempts: number;
  activation_locked_until: Date | null;
  public_token: string;
}

/** Who becomes the owner: a brand-new account (first activation) or an existing customer. */
type NewOwner =
  | { kind: 'new-account'; passwordHash: string; recoveryCodeHash: string; name?: string }
  | { kind: 'existing'; userId: string };

type PinCheck = { ok: true; helmet: LockedHelmet } | { ok: false; lockedUntil: Date | null };

/**
 * Activation: the concealed one-time Activation PIN is the proof of possession.
 * Every PIN check — preliminary or final — runs under a row lock and records failures for the
 * progressive per-helmet lockout, plus per-IP (and per-customer) failure budgets.
 */
@Injectable()
export class ActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: ActivationPolicy,
    private readonly hashing: HashingService,
    private readonly statuses: HelmetStatusService,
    private readonly audit: AuditService,
    private readonly limiter: RedisRateLimiter,
    private readonly publicCache: PublicEmergencyCacheService,
    private readonly customerHelmets: CustomerHelmetsService,
    private readonly customerAuth: CustomerAuthService,
    private readonly credentials: CustomerCredentialsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Preliminary check before asking for a password: helmet eligible AND PIN correct. Does not
   * consume anything. Ineligible and unknown helmets get the same HELMET_NOT_ACTIVATABLE.
   */
  async validate(dto: ActivationPinDto, meta: RequestMeta): Promise<ActivationValidateResponse> {
    await this.assertBudget(meta, null);
    const helmetId = await this.resolveTarget(dto, { genericNotFound: true });
    const check = await this.prisma.$transaction((tx) =>
      this.checkPin(tx, helmetId, dto.pin, meta, null, { genericDenials: true }),
    );
    if (!check.ok) return this.failed(meta, null, check.lockedUntil);
    const helmet = await this.prisma.helmet.findUniqueOrThrow({
      where: { id: helmetId },
      select: { helmetCode: true, helmetModel: { select: { name: true, brand: true } } },
    });
    return {
      activatable: true,
      helmet: {
        modelName: helmet.helmetModel.name,
        brand: helmet.helmetModel.brand,
        helmetCode: helmet.helmetCode,
      },
    };
  }

  /**
   * First activation: PIN + new password. In ONE transaction (helmet row locked): re-verify the
   * PIN, create the account (password + recovery code hashes), create ownership, consume the
   * PIN, purge escrow, move to ACTIVATED, write history and audits. Returns a session and the
   * plaintext recovery code (shown once).
   */
  async register(
    dto: RegisterActivationDto,
    meta: RequestMeta,
  ): Promise<{
    result: ActivationRegisterResponse;
    refresh: Awaited<ReturnType<CustomerAuthService['startSession']>>['refresh'];
  }> {
    await this.assertBudget(meta, null);
    const helmetId = await this.resolveTarget(dto, { genericNotFound: false });
    const { helmetCode } = await this.prisma.helmet.findUniqueOrThrow({
      where: { id: helmetId },
      select: { helmetCode: true },
    });
    this.credentials.assertAcceptablePassword(dto.password, { helmetCode, activationPin: dto.pin });

    // Expensive hashing happens before taking the row lock.
    const [passwordHash, recovery] = await Promise.all([
      this.credentials.hashPassword(dto.password),
      this.credentials.newRecoveryCode(),
    ]);
    const { userId, publicToken } = await this.activate(helmetId, dto.pin, meta, {
      kind: 'new-account',
      passwordHash,
      recoveryCodeHash: recovery.hash,
      name: dto.name,
    });

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const session = await this.customerAuth.startSession(user, meta);
    await this.publicCache.invalidate(publicToken);
    const helmet = await this.customerHelmets.get(userId, helmetId);
    return {
      result: { ...session.response, recoveryCode: recovery.code, helmet },
      refresh: session.refresh,
    };
  }

  /** Existing (signed-in) customer activates another helmet; no new account is created. */
  async addHelmet(
    customer: AuthenticatedCustomer,
    dto: ActivationPinDto,
    meta: RequestMeta,
  ): Promise<ActivationAddHelmetResponse> {
    await this.assertBudget(meta, customer.id);
    const helmetId = await this.resolveTarget(dto, { genericNotFound: false });
    const { publicToken } = await this.activate(helmetId, dto.pin, meta, {
      kind: 'existing',
      userId: customer.id,
    });
    await this.publicCache.invalidate(publicToken);
    return { helmet: await this.customerHelmets.get(customer.id, helmetId) };
  }

  private async activate(
    helmetId: string,
    pin: string,
    meta: RequestMeta,
    owner: NewOwner,
  ): Promise<{ userId: string; publicToken: string }> {
    const actingUser = owner.kind === 'existing' ? owner.userId : null;
    let outcome:
      { ok: true; userId: string; publicToken: string } | { ok: false; lockedUntil: Date | null };
    try {
      outcome = await this.prisma.$transaction(
        async (tx) => {
          const check = await this.checkPin(tx, helmetId, pin, meta, actingUser, {
            genericDenials: false,
          });
          if (!check.ok) return check;
          const helmet = check.helmet;
          const now = new Date();

          let userId: string;
          if (owner.kind === 'new-account') {
            userId = uuidv7();
            await tx.user.create({
              data: {
                id: userId,
                name: owner.name,
                passwordHash: owner.passwordHash,
                passwordChangedAt: now,
                recoveryCodeHash: owner.recoveryCodeHash,
                recoveryCodeCreatedAt: now,
              },
            });
            await this.audit.record(
              {
                action: AuditAction.CUSTOMER_CREATED,
                entityType: 'user',
                entityId: userId,
                userId,
                ipHash: meta.ipHash,
                metadata: { via: 'activation' },
              },
              tx,
            );
          } else {
            userId = owner.userId;
          }

          await tx.helmetOwnership.create({
            data: { helmetId: helmet.id, userId, status: 'ACTIVE', activatedAt: now },
          });
          const purged = await tx.helmetActivationSecret.deleteMany({
            where: { helmetId: helmet.id },
          });
          await this.statuses.apply(tx, {
            helmetId: helmet.id,
            from: helmet.status,
            to: 'ACTIVATED',
            actor: { type: ActorType.SYSTEM, id: userId },
            reason:
              owner.kind === 'new-account'
                ? 'Activated with PIN (new account)'
                : 'Activated with PIN (existing account)',
            extra: {
              activatedAt: now,
              activationPinUsed: true,
              activationAttempts: 0,
              activationLockedUntil: null,
            },
          });
          await this.audit.record(
            {
              action: AuditAction.HELMET_ACTIVATED,
              entityType: 'helmet',
              entityId: helmet.id,
              userId,
              ipHash: meta.ipHash,
              metadata: { fromStatus: helmet.status, newAccount: owner.kind === 'new-account' },
            },
            tx,
          );
          await this.audit.record(
            {
              action: AuditAction.ACTIVATION_PIN_CONSUMED,
              entityType: 'helmet',
              entityId: helmet.id,
              userId,
              ipHash: meta.ipHash,
              metadata: { escrowPurged: purged.count > 0 },
            },
            tx,
          );
          return { ok: true as const, userId, publicToken: helmet.public_token };
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (err) {
      // Defence in depth: the partial unique index allows only one ACTIVE ownership per helmet.
      if (isUniqueViolation(err))
        throw AppException.conflict(
          ErrorCode.HELMET_ALREADY_ACTIVATED,
          'This helmet has already been activated.',
        );
      throw err;
    }
    if (!outcome.ok) return this.failed(meta, actingUser, outcome.lockedUntil);
    return { userId: outcome.userId, publicToken: outcome.publicToken };
  }

  /**
   * Locks the helmet row, applies the eligibility policy and verifies the PIN. A wrong PIN
   * increments the persistent counter (and may start an escalating lock) — this write commits
   * because the caller returns normally instead of throwing inside the transaction.
   */
  private async checkPin(
    tx: PrismaTx,
    helmetId: string,
    pin: string,
    meta: RequestMeta,
    userId: string | null,
    opts: { genericDenials: boolean },
  ): Promise<PinCheck> {
    const [helmet] = await tx.$queryRaw<LockedHelmet[]>`
      SELECT id, helmet_code, status, activation_pin_used, activation_pin_hash, activation_attempts, activation_locked_until, public_token
      FROM helmets WHERE id = ${helmetId}::uuid FOR UPDATE`;
    if (!helmet) throw this.notActivatable();
    const activeOwners = await tx.helmetOwnership.count({ where: { helmetId, status: 'ACTIVE' } });
    const denial = this.policy.evaluate({
      status: helmet.status,
      activationPinUsed: helmet.activation_pin_used,
      hasActiveOwner: activeOwners > 0,
      activationLockedUntil: helmet.activation_locked_until,
    });
    if (denial) {
      if (opts.genericDenials && denial.code !== ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED)
        throw this.notActivatable();
      throw new AppException(denial.code, denial.message, denial.status, denial.details);
    }
    if (PIN_REGEX.test(pin) && (await this.hashing.verifyPin(helmet.activation_pin_hash, pin)))
      return { ok: true, helmet };

    const attempts = helmet.activation_attempts + 1;
    const lockedUntil = this.policy.lockoutAfterFailure(attempts);
    await tx.helmet.update({
      where: { id: helmet.id },
      data: {
        activationAttempts: attempts,
        ...(lockedUntil ? { activationLockedUntil: lockedUntil } : {}),
      },
    });
    // The attempted PIN is never recorded.
    await this.audit.record(
      {
        action: AuditAction.ACTIVATION_FAILED,
        entityType: 'helmet',
        entityId: helmet.id,
        userId,
        ipHash: meta.ipHash,
        metadata: { attempts },
      },
      tx,
    );
    if (lockedUntil) {
      await this.audit.record(
        {
          action: AuditAction.ACTIVATION_LOCKED,
          entityType: 'helmet',
          entityId: helmet.id,
          userId,
          ipHash: meta.ipHash,
          metadata: { attempts, lockedUntil: lockedUntil.toISOString() },
        },
        tx,
      );
    }
    return { ok: false, lockedUntil };
  }

  /** Records a failed PIN against IP/customer budgets and throws the matching error. */
  private async failed(
    meta: RequestMeta,
    userId: string | null,
    lockedUntil: Date | null,
  ): Promise<never> {
    if (meta.ipHash)
      await this.limiter.hit(
        `activation:fail:ip:${meta.ipHash}`,
        this.config.get('ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR'),
        HOUR,
      );
    if (userId)
      await this.limiter.hit(
        `activation:fail:user:${userId}`,
        this.config.get('ACTIVATION_MAX_FAILURES_PER_CUSTOMER_PER_HOUR'),
        HOUR,
      );
    if (lockedUntil)
      throw this.attemptsExceeded(Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
    throw new AppException(
      ErrorCode.INVALID_ACTIVATION_PIN,
      'That activation PIN is incorrect. Check the code on your activation card.',
      HttpStatus.BAD_REQUEST,
    );
  }

  private async resolveTarget(
    target: ActivationTargetDto,
    opts: { genericNotFound: boolean },
  ): Promise<string> {
    if (Boolean(target.publicToken) === Boolean(target.helmetCode)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Provide either the QR token or the Helmet ID.',
        HttpStatus.BAD_REQUEST,
      );
    }
    let helmet: { id: string } | null = null;
    if (target.publicToken) {
      helmet = isValidPublicToken(target.publicToken)
        ? await this.prisma.helmet.findUnique({
            where: { publicToken: target.publicToken },
            select: { id: true },
          })
        : null;
    } else {
      // Checksum validation rejects typos before touching the database.
      const code = this.credentials.canonicalHelmetCode(target.helmetCode ?? '');
      helmet = await this.prisma.helmet.findUnique({
        where: { helmetCode: code },
        select: { id: true },
      });
    }
    if (!helmet)
      throw opts.genericNotFound
        ? this.notActivatable()
        : AppException.notFound(
            ErrorCode.HELMET_NOT_FOUND,
            'Helmet not found. Check the Helmet ID.',
          );
    return helmet.id;
  }

  private async assertBudget(meta: RequestMeta, userId: string | null): Promise<void> {
    const checks = [];
    if (meta.ipHash)
      checks.push(
        this.limiter.peek(
          `activation:fail:ip:${meta.ipHash}`,
          this.config.get('ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR'),
        ),
      );
    if (userId)
      checks.push(
        this.limiter.peek(
          `activation:fail:user:${userId}`,
          this.config.get('ACTIVATION_MAX_FAILURES_PER_CUSTOMER_PER_HOUR'),
        ),
      );
    const blocked = (await Promise.all(checks)).find((r) => !r.allowed);
    if (blocked) throw this.attemptsExceeded(blocked.retryAfter);
  }

  private notActivatable(): AppException {
    return new AppException(
      ErrorCode.HELMET_NOT_ACTIVATABLE,
      'This helmet cannot be activated. Check the Helmet ID, or contact your retailer or support.',
      HttpStatus.CONFLICT,
    );
  }

  private attemptsExceeded(retryAfter: number): AppException {
    return new AppException(
      ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED,
      'Too many incorrect PIN attempts. Please wait before trying again.',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfter },
    );
  }
}
