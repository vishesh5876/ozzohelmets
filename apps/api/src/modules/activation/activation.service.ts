import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ACTIVATION_PIN_ALPHABET,
  ACTIVATION_PIN_LENGTH,
  type ActivationResultDto,
  type ActivationValidateResponse,
  ActorType,
  ErrorCode,
  isValidHelmetCode,
  isValidPublicToken,
  normalizeHelmetCode,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { HashingService } from '../../security/hashing.service';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CustomerAuthService } from '../customer-auth/customer-auth.service';
import { CustomerHelmetsService } from '../customer-helmets/customer-helmets.service';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { ActivationPolicy } from './domain/activation-policy';
import type { ActivationTargetDto, CompleteActivationDto } from './dto/activation.dto';

const PIN_REGEX = new RegExp(`^[${ACTIVATION_PIN_ALPHABET}]{${ACTIVATION_PIN_LENGTH}}$`);
const HOUR = 3600;

interface LockedHelmet {
  id: string;
  status: ActivationResultDto['helmet']['status'];
  activation_pin_used: boolean;
  activation_pin_hash: string;
  activation_attempts: number;
  activation_locked_until: Date | null;
  public_token: string;
}

type TxOutcome =
  | { kind: 'activated'; publicToken: string }
  | { kind: 'wrong-pin'; publicToken: string; lockedUntil: Date | null; attempts: number };

@Injectable()
export class ActivationService {
  private readonly logger = new Logger(ActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: ActivationPolicy,
    private readonly hashing: HashingService,
    private readonly statuses: HelmetStatusService,
    private readonly audit: AuditService,
    private readonly limiter: RedisRateLimiter,
    private readonly publicCache: PublicEmergencyCacheService,
    private readonly customerHelmets: CustomerHelmetsService,
    private readonly customers: CustomerAuthService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Unauthenticated pre-check used before asking for a phone number. Every ineligible case
   * (unknown, already owned, wrong status) returns the same HELMET_NOT_ACTIVATABLE so the
   * endpoint can't be used to discover which helmets exist or are owned. PINs are NOT checked here.
   */
  async validate(
    target: ActivationTargetDto,
    meta: RequestMeta,
  ): Promise<ActivationValidateResponse> {
    if (meta.ipHash) {
      const limit = await this.limiter.hit(`activation:validate:ip:${meta.ipHash}`, 60, HOUR);
      if (!limit.allowed) throw this.attemptsExceeded(limit.retryAfter);
    }
    const helmet = await this.findTarget(target, {
      activationPinUsed: true,
      status: true,
      activationLockedUntil: true,
      helmetCode: true,
      ownerships: { where: { status: 'ACTIVE' }, select: { id: true } },
      helmetModel: { select: { name: true, brand: true } },
    });
    const denial =
      helmet &&
      this.policy.evaluate({
        status: helmet.status,
        activationPinUsed: helmet.activationPinUsed,
        hasActiveOwner: helmet.ownerships.length > 0,
        activationLockedUntil: null,
      });
    if (!helmet || denial) throw this.notActivatable();
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
   * Atomic activation for an authenticated (OTP-verified) customer:
   *  lock helmet row → eligibility → no active owner → PIN unused → verify PIN →
   *  ownership + PIN consumed + escrow purge + ACTIVATED + history + audit, in one transaction.
   * A wrong PIN commits only the failure counter (and a progressive lockout).
   */
  async complete(
    customer: AuthenticatedCustomer,
    dto: CompleteActivationDto,
    meta: RequestMeta,
  ): Promise<ActivationResultDto> {
    await this.assertCustomerAndIpBudget(customer, meta);
    if (!PIN_REGEX.test(dto.pin)) {
      throw new AppException(
        ErrorCode.INVALID_ACTIVATION_PIN,
        'That activation PIN is not valid. Check the code on your helmet label.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const target = await this.findTarget(dto, { id: true });
    if (!target)
      throw AppException.notFound(
        ErrorCode.HELMET_NOT_FOUND,
        'Helmet not found. Check the Helmet ID.',
      );

    let outcome: TxOutcome;
    try {
      outcome = await this.prisma.$transaction(
        async (tx): Promise<TxOutcome> => {
          // Row lock: concurrent activations of the same helmet are serialised here.
          const [helmet] = await tx.$queryRaw<LockedHelmet[]>`
            SELECT id, status, activation_pin_used, activation_pin_hash, activation_attempts, activation_locked_until, public_token
            FROM helmets WHERE id = ${target.id}::uuid FOR UPDATE`;
          if (!helmet) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
          const activeOwners = await tx.helmetOwnership.count({
            where: { helmetId: helmet.id, status: 'ACTIVE' },
          });

          const denial = this.policy.evaluate({
            status: helmet.status,
            activationPinUsed: helmet.activation_pin_used,
            hasActiveOwner: activeOwners > 0,
            activationLockedUntil: helmet.activation_locked_until,
          });
          if (denial)
            throw new AppException(denial.code, denial.message, denial.status, denial.details);

          if (!(await this.hashing.verifyPin(helmet.activation_pin_hash, dto.pin))) {
            const attempts = helmet.activation_attempts + 1;
            const lockedUntil = this.policy.lockoutAfterFailure(attempts);
            await tx.helmet.update({
              where: { id: helmet.id },
              data: {
                activationAttempts: attempts,
                ...(lockedUntil ? { activationLockedUntil: lockedUntil } : {}),
              },
            });
            await this.audit.record(
              {
                action: AuditAction.ACTIVATION_FAILED,
                entityType: 'helmet',
                entityId: helmet.id,
                userId: customer.id,
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
                  userId: customer.id,
                  ipHash: meta.ipHash,
                  metadata: { attempts, lockedUntil: lockedUntil.toISOString() },
                },
                tx,
              );
            }
            return { kind: 'wrong-pin', publicToken: helmet.public_token, lockedUntil, attempts };
          }

          const now = new Date();
          await tx.helmetOwnership.create({
            data: { helmetId: helmet.id, userId: customer.id, status: 'ACTIVE', activatedAt: now },
          });
          const purged = await tx.helmetActivationSecret.deleteMany({
            where: { helmetId: helmet.id },
          });
          await this.statuses.apply(tx, {
            helmetId: helmet.id,
            from: helmet.status,
            to: 'ACTIVATED',
            actor: { type: ActorType.SYSTEM, id: customer.id },
            reason: 'Activated by owner (PIN + mobile OTP)',
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
              userId: customer.id,
              ipHash: meta.ipHash,
              metadata: { fromStatus: helmet.status },
            },
            tx,
          );
          await this.audit.record(
            {
              action: AuditAction.ACTIVATION_PIN_CONSUMED,
              entityType: 'helmet',
              entityId: helmet.id,
              userId: customer.id,
              ipHash: meta.ipHash,
              metadata: { escrowPurged: purged.count > 0 },
            },
            tx,
          );
          return { kind: 'activated', publicToken: helmet.public_token };
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

    if (outcome.kind === 'wrong-pin') {
      await this.recordFailure(customer, meta);
      if (outcome.lockedUntil)
        throw this.attemptsExceeded(Math.ceil((outcome.lockedUntil.getTime() - Date.now()) / 1000));
      throw new AppException(
        ErrorCode.INVALID_ACTIVATION_PIN,
        'That activation PIN is incorrect. Check the code on your helmet label.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.publicCache.invalidate(outcome.publicToken);
    const [helmet, profile] = await Promise.all([
      this.customerHelmets.get(customer.id, target.id),
      this.customers.profile(customer.id),
    ]);
    return { helmet, customer: profile };
  }

  private async findTarget<S extends Record<string, unknown>>(
    target: ActivationTargetDto,
    select: S,
  ) {
    if (Boolean(target.publicToken) === Boolean(target.helmetCode)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Provide either the QR token or the Helmet ID.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (target.publicToken) {
      if (!isValidPublicToken(target.publicToken)) return null;
      return this.prisma.helmet.findUnique({ where: { publicToken: target.publicToken }, select });
    }
    const code = normalizeHelmetCode(target.helmetCode ?? '');
    // Checksum validation rejects typos before touching the database.
    if (!code || !isValidHelmetCode(code)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'That Helmet ID is not valid. Check it and try again.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.prisma.helmet.findUnique({ where: { helmetCode: code }, select });
  }

  private async assertCustomerAndIpBudget(
    customer: AuthenticatedCustomer,
    meta: RequestMeta,
  ): Promise<void> {
    const checks = [
      this.limiter.peek(
        `activation:fail:user:${customer.id}`,
        this.config.get('ACTIVATION_MAX_FAILURES_PER_CUSTOMER_PER_HOUR'),
      ),
    ];
    if (meta.ipHash)
      checks.push(
        this.limiter.peek(
          `activation:fail:ip:${meta.ipHash}`,
          this.config.get('ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR'),
        ),
      );
    const results = await Promise.all(checks);
    const blocked = results.find((r) => !r.allowed);
    if (blocked) throw this.attemptsExceeded(blocked.retryAfter);
  }

  private async recordFailure(customer: AuthenticatedCustomer, meta: RequestMeta): Promise<void> {
    await this.limiter.hit(
      `activation:fail:user:${customer.id}`,
      this.config.get('ACTIVATION_MAX_FAILURES_PER_CUSTOMER_PER_HOUR'),
      HOUR,
    );
    if (meta.ipHash)
      await this.limiter.hit(
        `activation:fail:ip:${meta.ipHash}`,
        this.config.get('ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR'),
        HOUR,
      );
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
      'Too many activation attempts. Please try again later.',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfter },
    );
  }
}
