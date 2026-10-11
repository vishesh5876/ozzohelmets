import { SecurityEventsService } from '../customer-security/security-events.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ACTIVATION_PIN_ALPHABET,
  ACTIVATION_PIN_LENGTH,
  type ActivationAddSafetyIdResponse,
  type ActivationRegisterResponse,
  type ActivationValidateResponse,
  ActorType,
  ErrorCode,
  isValidPublicToken,
  isValidSafetyCode,
  normalizeSafetyCode,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import {
  isEmailUniqueViolation,
  isUniqueViolation,
} from '../../infrastructure/prisma/prisma-errors';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { HashingService } from '../../security/hashing.service';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CustomerAuthService } from '../customer-auth/customer-auth.service';
import {
  CustomerAccountsService,
  type PreparedAccount,
} from '../customer-auth/customer-accounts.service';
import { CustomerCredentialsService } from '../customer-auth/customer-credentials.service';
import { CustomerHelmetsService } from '../customer-helmets/customer-helmets.service';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { CustomerSafetyIdsService } from '../safety-ids/customer-safety-ids.service';
import {
  type LockedSafetyIdState,
  SafetyIdCoreService,
} from '../safety-ids/domain/safety-id-core.service';
import { ActivationPolicy } from './domain/activation-policy';
import type {
  ActivationPinDto,
  ActivationTargetDto,
  RegisterActivationDto,
} from './dto/activation.dto';

const PIN_REGEX = new RegExp(`^[${ACTIVATION_PIN_ALPHABET}]{${ACTIVATION_PIN_LENGTH}}$`);
const HOUR = 3600;

/** Who becomes the owner: a brand-new account (first activation) or an existing customer. */
type NewOwner =
  { kind: 'new-account'; account: PreparedAccount } | { kind: 'existing'; userId: string };

type PinCheck = { ok: true; state: LockedSafetyIdState } | { ok: false; lockedUntil: Date | null };

interface ActivationOutcome {
  userId: string;
  safetyId: string;
  helmetId: string | null;
  publicToken: string;
}

/**
 * Activation (Phase 9): starts from the Safety ID. The one-time Activation PIN printed with the
 * Safety ID is the proof of possession. Every PIN check — preliminary or final — runs under row
 * locks (linked helmet → Safety ID) and records failures for the progressive per-Safety-ID
 * lockout, plus per-IP (and per-customer) failure budgets. A linked, unowned helmet becomes the
 * same customer's in the same transaction; a linked helmet owned by someone else blocks it.
 */
@Injectable()
export class ActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: ActivationPolicy,
    private readonly hashing: HashingService,
    private readonly statuses: HelmetStatusService,
    private readonly core: SafetyIdCoreService,
    private readonly audit: AuditService,
    private readonly limiter: RedisRateLimiter,
    private readonly publicCache: PublicEmergencyCacheService,
    private readonly customerHelmets: CustomerHelmetsService,
    private readonly customerSafetyIds: CustomerSafetyIdsService,
    private readonly customerAuth: CustomerAuthService,
    private readonly credentials: CustomerCredentialsService,
    private readonly accounts: CustomerAccountsService,
    private readonly config: AppConfigService,
    private readonly events: SecurityEventsService,
  ) {}

  /**
   * Preliminary check before asking for a password: Safety ID eligible AND PIN correct. Does not
   * consume anything. Ineligible and unknown Safety IDs get the same SAFETY_ID_NOT_ACTIVATABLE.
   */
  async validate(dto: ActivationPinDto, meta: RequestMeta): Promise<ActivationValidateResponse> {
    await this.assertBudget(meta, null);
    const safetyId = await this.resolveTarget(dto, { genericNotFound: true });
    const check = await this.prisma.$transaction((tx) =>
      this.checkPin(tx, safetyId, dto.pin, meta, null, { genericDenials: true }),
    );
    if (!check.ok) return this.failed(meta, null, check.lockedUntil);
    // A linked helmet that is owned or not activatable: same generic answer (no oracle).
    if (
      this.policy.evaluateLink({
        helmet: check.state.helmet
          ? { status: check.state.helmet.status, ownerId: check.state.helmet.ownerId }
          : null,
        actingUserId: null,
      })
    )
      throw this.notActivatable();
    const helmet = check.state.helmet
      ? await this.prisma.helmet.findUniqueOrThrow({
          where: { id: check.state.helmet.id },
          select: { helmetCode: true, helmetModel: { select: { name: true, brand: true } } },
        })
      : null;
    return {
      activatable: true,
      safetyId: { safetyCode: check.state.safetyId.safetyCode },
      linkedHelmet: helmet
        ? {
            modelName: helmet.helmetModel.name,
            brand: helmet.helmetModel.brand,
            helmetCode: helmet.helmetCode,
          }
        : null,
    };
  }

  /**
   * First activation: PIN + account email + new password. In ONE transaction (rows locked):
   * check eligibility, re-verify the PIN, confirm the email is free, create the account, create
   * the Safety ID ownership (and the linked helmet's, if unowned), consume the PIN, purge escrow,
   * move to ACTIVATED, write audits. Any failure rolls everything back, so a taken email never
   * consumes the PIN. Returns a session and the plaintext recovery code (shown once).
   */
  async register(
    dto: RegisterActivationDto,
    meta: RequestMeta,
  ): Promise<{
    result: ActivationRegisterResponse;
    refresh: Awaited<ReturnType<CustomerAuthService['startSession']>>['refresh'];
  }> {
    await this.assertBudget(meta, null);
    const safetyId = await this.resolveTarget(dto, { genericNotFound: false });
    const { safetyCode } = await this.prisma.safetyId.findUniqueOrThrow({
      where: { id: safetyId },
      select: { safetyCode: true },
    });
    // Policy check + expensive hashing happen before taking the row locks.
    const account = await this.accounts.prepare(dto.password, {
      email: dto.email,
      helmetCode: safetyCode,
      activationPin: dto.pin,
      name: dto.name,
    });
    const outcome = await this.activate(safetyId, dto.pin, meta, {
      kind: 'new-account',
      account,
    });

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: outcome.userId } });
    const session = await this.customerAuth.startSession(user, meta);
    await this.publicCache.invalidate(outcome.publicToken);
    return {
      result: {
        ...session.response,
        recoveryCode: account.recoveryCode,
        ...(await this.activated(outcome)),
      },
      refresh: session.refresh,
    };
  }

  /** Existing (signed-in) customer activates another Safety ID; no new account is created. */
  async addSafetyId(
    customer: AuthenticatedCustomer,
    dto: ActivationPinDto,
    meta: RequestMeta,
  ): Promise<ActivationAddSafetyIdResponse> {
    await this.assertBudget(meta, customer.id);
    const safetyId = await this.resolveTarget(dto, { genericNotFound: false });
    const outcome = await this.activate(safetyId, dto.pin, meta, {
      kind: 'existing',
      userId: customer.id,
    });
    await this.publicCache.invalidate(outcome.publicToken);
    return this.activated(outcome);
  }

  private async activated(outcome: ActivationOutcome): Promise<ActivationAddSafetyIdResponse> {
    const [safetyId, helmet] = await Promise.all([
      this.customerSafetyIds.get(outcome.userId, outcome.safetyId),
      outcome.helmetId ? this.customerHelmets.get(outcome.userId, outcome.helmetId) : null,
    ]);
    return { safetyId, helmet };
  }

  private async activate(
    safetyId: string,
    pin: string,
    meta: RequestMeta,
    owner: NewOwner,
  ): Promise<ActivationOutcome> {
    const actingUser = owner.kind === 'existing' ? owner.userId : null;
    let outcome: (ActivationOutcome & { ok: true }) | { ok: false; lockedUntil: Date | null };
    try {
      outcome = await this.prisma.$transaction(
        async (tx) => {
          const check = await this.checkPin(tx, safetyId, pin, meta, actingUser, {
            genericDenials: false,
          });
          if (!check.ok) return check;
          const { safetyId: sid, helmet } = check.state;
          // After the PIN: the linked helmet must not belong to someone else.
          const linkDenial = this.policy.evaluateLink({
            helmet: helmet ? { status: helmet.status, ownerId: helmet.ownerId } : null,
            actingUserId: actingUser,
          });
          if (linkDenial)
            throw new AppException(
              linkDenial.code,
              linkDenial.message,
              linkDenial.status,
              linkDenial.details,
            );
          const now = new Date();
          const userId =
            owner.kind === 'new-account'
              ? await this.accounts.create(tx, owner.account, meta, 'activation')
              : owner.userId;

          await this.core.startOwnership(tx, sid.id, userId, 'ACTIVATION', now);
          const purged = await tx.safetyIdActivationSecret.deleteMany({
            where: { safetyId: sid.id },
          });
          await this.core.setStatus(tx, sid.id, sid.status, 'ACTIVATED', {
            activatedAt: now,
            activationPinUsed: true,
            activationAttempts: 0,
            activationLockedUntil: null,
          });

          let boundHelmet = false;
          if (helmet && !helmet.ownerId) {
            // The helmet this Safety ID came with becomes the same customer's.
            await tx.helmetOwnership.create({
              data: {
                helmetId: helmet.id,
                userId,
                status: 'ACTIVE',
                acquiredVia: 'ACTIVATION',
                activatedAt: now,
              },
            });
            // Phase 8 helmet escrow (same id for migrated rows) and PIN flag stay consistent.
            await tx.helmetActivationSecret.deleteMany({ where: { helmetId: helmet.id } });
            await this.statuses.apply(tx, {
              helmetId: helmet.id,
              from: helmet.status,
              to: 'ACTIVATED',
              actor: { type: ActorType.SYSTEM, id: userId },
              reason: `Activated with Safety ID ${sid.safetyCode}`,
              extra: {
                activatedAt: now,
                activationPinUsed: true,
                activationAttempts: 0,
                activationLockedUntil: null,
              },
            });
            boundHelmet = true;
            await this.audit.record(
              {
                action: AuditAction.HELMET_ACTIVATED,
                entityType: 'helmet',
                entityId: helmet.id,
                userId,
                ipHash: meta.ipHash,
                metadata: {
                  fromStatus: helmet.status,
                  newAccount: owner.kind === 'new-account',
                  safetyId: sid.id,
                },
              },
              tx,
            );
          }
          await this.audit.record(
            {
              action: AuditAction.SAFETY_ID_ACTIVATED,
              entityType: 'safety_id',
              entityId: sid.id,
              userId,
              ipHash: meta.ipHash,
              metadata: {
                fromStatus: sid.status,
                newAccount: owner.kind === 'new-account',
                linkedHelmetId: helmet?.id ?? null,
                helmetBound: boundHelmet,
              },
            },
            tx,
          );
          await this.audit.record(
            {
              action: AuditAction.SAFETY_ID_PIN_CONSUMED,
              entityType: 'safety_id',
              entityId: sid.id,
              userId,
              ipHash: meta.ipHash,
              metadata: { escrowPurged: purged.count > 0 },
            },
            tx,
          );
          return {
            ok: true as const,
            userId,
            safetyId: sid.id,
            helmetId: helmet?.id ?? null,
            publicToken: sid.publicToken,
          };
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (err) {
      // Defence in depth: partial unique indexes allow one live account per email and one ACTIVE
      // ownership per Safety ID / helmet.
      if (isEmailUniqueViolation(err)) throw this.accounts.emailTaken();
      if (isUniqueViolation(err))
        throw AppException.conflict(
          ErrorCode.SAFETY_ID_ALREADY_ACTIVATED,
          'This Safety ID has already been activated.',
        );
      throw err;
    }
    if (!outcome.ok) return this.failed(meta, actingUser, outcome.lockedUntil);
    await this.events.record(outcome.userId, 'SAFETY_ID_ACTIVATED', meta);
    const { ok: _ok, ...result } = outcome;
    return result;
  }

  /**
   * Locks the Safety ID (and its linked helmet), applies the eligibility policy and verifies the
   * PIN. A wrong PIN increments the persistent counter (and may start an escalating lock) — this
   * write commits because the caller returns normally instead of throwing inside the transaction.
   */
  private async checkPin(
    tx: PrismaTx,
    safetyId: string,
    pin: string,
    meta: RequestMeta,
    userId: string | null,
    opts: { genericDenials: boolean },
  ): Promise<PinCheck> {
    const state = await this.core.lock(tx, { id: safetyId });
    if (!state) throw this.notActivatable();
    const sid = state.safetyId;
    const denial = this.policy.evaluate({
      status: sid.status,
      activationPinUsed: sid.activationPinUsed,
      hasActiveOwner: state.ownership !== null,
      activationLockedUntil: sid.activationLockedUntil,
    });
    if (denial) {
      if (opts.genericDenials && denial.code !== ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED)
        throw this.notActivatable();
      throw new AppException(denial.code, denial.message, denial.status, denial.details);
    }
    if (PIN_REGEX.test(pin) && (await this.hashing.verifyPin(sid.activationPinHash, pin)))
      return { ok: true, state };

    const attempts = sid.activationAttempts + 1;
    const lockedUntil = this.policy.lockoutAfterFailure(attempts);
    await tx.safetyId.update({
      where: { id: sid.id },
      data: {
        activationAttempts: attempts,
        ...(lockedUntil ? { activationLockedUntil: lockedUntil } : {}),
      },
    });
    // The attempted PIN is never recorded.
    await this.audit.record(
      {
        action: AuditAction.SAFETY_ID_ACTIVATION_FAILED,
        entityType: 'safety_id',
        entityId: sid.id,
        userId,
        ipHash: meta.ipHash,
        metadata: { attempts },
      },
      tx,
    );
    if (lockedUntil) {
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_ACTIVATION_LOCKED,
          entityType: 'safety_id',
          entityId: sid.id,
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
      'The Activation PIN could not be verified. Check the PIN printed with your Safety ID.',
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Resolves the Safety ID from the QR token (scan flow), the printed Safety ID code, or — for
   * Phase 8 activation cards that print the Helmet ID — the helmet's linked Safety ID.
   */
  private async resolveTarget(
    target: ActivationTargetDto,
    opts: { genericNotFound: boolean },
  ): Promise<string> {
    const given = [target.publicToken, target.safetyCode, target.helmetCode].filter(Boolean);
    if (given.length !== 1) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Provide the QR token, the Safety ID or the Helmet ID.',
        HttpStatus.BAD_REQUEST,
      );
    }
    let id: string | null = null;
    if (target.publicToken) {
      id = isValidPublicToken(target.publicToken)
        ? await this.core.findId(this.prisma, { publicToken: target.publicToken })
        : null;
    } else if (target.safetyCode) {
      const code = normalizeSafetyCode(target.safetyCode);
      if (!code || !isValidSafetyCode(code))
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'That Safety ID is not valid. Check the characters printed next to the QR code.',
          HttpStatus.BAD_REQUEST,
        );
      id = await this.core.findId(this.prisma, { safetyCode: code });
    } else {
      // Checksum validation rejects typos before touching the database.
      const code = this.credentials.canonicalHelmetCode(target.helmetCode ?? '');
      const helmet = await this.prisma.helmet.findUnique({
        where: { helmetCode: code },
        select: { id: true },
      });
      id = helmet ? ((await this.core.linkedSafetyId(this.prisma, helmet.id))?.id ?? null) : null;
    }
    if (!id)
      throw opts.genericNotFound
        ? this.notActivatable()
        : AppException.notFound(
            ErrorCode.SAFETY_ID_NOT_FOUND,
            'We could not find this Safety ID. Check the characters printed next to the QR code.',
          );
    return id;
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
      ErrorCode.SAFETY_ID_NOT_ACTIVATABLE,
      'This Safety ID cannot be activated. Check the Safety ID, or contact support.',
      HttpStatus.CONFLICT,
    );
  }

  private attemptsExceeded(retryAfter: number): AppException {
    return new AppException(
      ErrorCode.ACTIVATION_ATTEMPTS_EXCEEDED,
      'Too many incorrect Activation PIN attempts. Please wait before trying again.',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfter },
    );
  }
}
