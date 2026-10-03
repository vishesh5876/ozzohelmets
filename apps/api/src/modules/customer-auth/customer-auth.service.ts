import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import type Redis from 'ioredis';
import {
  type CustomerLoginResponse,
  type CustomerProfile,
  type CustomerRecoverResponse,
  type CustomerSessionDto,
  ErrorCode,
  normalizeRecoveryCode,
  type RecentAuthResponse,
  parseAccountIdentifier,
  type RecoveryCodeIssued,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { normalizePhone } from '../../common/utils/phone';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';
import { LockoutService } from '../../security/lockout';
import { RecentAuthService } from '../../security/recent-auth.service';
import { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import type { IssuedRefreshToken } from '../../security/refresh-token-rotator';
import { opaqueToken } from '../../security/secure-random';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedCustomer } from './customer-auth.types';
import { CustomerCredentialsService } from './customer-credentials.service';
import { CustomerTokenService } from './customer-token.service';
import type { UpdateCustomerDto } from './dto/customer-auth.dto';

export interface CustomerSession {
  response: CustomerLoginResponse;
  refresh: IssuedRefreshToken;
}

interface ResetTicket {
  userId: string;
  /** Recovery hash at verification time; the reset fails if it changed in between (single use). */
  recoveryCodeHash: string;
}

const HOUR = 3600;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Customer authentication. Identity = ownership of a helmet:
 *  - login: any currently owned Helmet ID + password
 *  - recovery: Helmet ID + offline recovery code → single-use reset token → new password
 * All failures for unknown helmets, unowned helmets and wrong secrets are indistinguishable.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CustomerCredentialsService,
    private readonly tokens: CustomerTokenService,
    private readonly lockout: LockoutService,
    private readonly limiter: RedisRateLimiter,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly recentAuth: RecentAuthService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Password re-check for sensitive actions. Returns a short-lived token bound to this session.
   * Failures count towards a per-account escalating lockout; the password is never logged.
   */
  async reauthenticate(
    customer: AuthenticatedCustomer,
    password: string,
    meta: RequestMeta,
  ): Promise<RecentAuthResponse> {
    const key = `customer-reauth:user:${customer.id}`;
    const state = await this.lockout.status(key);
    if (state.locked) throw this.locked(state.retryAfter);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    if (!(await this.credentials.verifyPassword(user.passwordHash, password))) {
      const failure = await this.lockout.fail(key, {
        threshold: this.config.get('CUSTOMER_LOGIN_FAILURES_BEFORE_LOCK'),
        baseSeconds: this.config.get('CUSTOMER_LOGIN_LOCKOUT_BASE_SECONDS'),
        maxSeconds: this.config.get('CUSTOMER_LOGIN_LOCKOUT_MAX_SECONDS'),
      });
      await this.audit.record({
        action: AuditAction.CUSTOMER_RECENT_AUTH_FAILED,
        entityType: 'user',
        entityId: user.id,
        userId: user.id,
        ipHash: meta.ipHash,
        metadata: { failures: failure.failures },
      });
      if (failure.locked) throw this.locked(failure.retryAfter);
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Your password is incorrect.',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.lockout.reset(key);
    const issued = await this.recentAuth.issue('customer', user.id, customer.sessionId);
    await this.audit.record({
      action: AuditAction.CUSTOMER_RECENT_AUTH_CREATED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      ipHash: meta.ipHash,
    });
    return issued;
  }

  /**
   * Sign in with a Helmet ID the account currently owns OR its permanent Customer ID, plus the
   * password. Unknown IDs, unowned helmets, wrong passwords and suspended accounts are
   * indistinguishable; lockouts apply per identifier and per account.
   */
  async login(
    rawIdentifier: string,
    password: string,
    meta: RequestMeta,
  ): Promise<CustomerSession> {
    const { key, user } = await this.resolveIdentifier(rawIdentifier, 'customer-login');
    const keys = this.lockKeys('customer-login', key, user);
    await this.assertNotLocked(
      keys,
      `customer-login:ip:${meta.ipHash}`,
      this.config.get('CUSTOMER_LOGIN_MAX_FAILURES_PER_IP_PER_HOUR'),
      meta,
    );

    const ok =
      (await this.credentials.verifyPassword(user?.passwordHash ?? null, password)) &&
      user?.status === 'ACTIVE';
    if (!ok || !user) {
      await this.recordFailure(keys, meta, 'login', user?.id ?? null);
      throw this.invalidCredentials();
    }
    await Promise.all(keys.map((k) => this.lockout.reset(k)));
    await this.audit.record({
      action: AuditAction.CUSTOMER_LOGIN,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      ipHash: meta.ipHash,
    });
    return this.startSession(user, meta);
  }

  /** Issues a new session (used after login, registration and password reset). */
  async startSession(user: User, meta: RequestMeta): Promise<CustomerSession> {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    const refresh = await this.tokens.issueRefreshToken(user.id, meta);
    const accessToken = await this.tokens.signAccessToken(user.id, refresh.familyId);
    return {
      response: {
        accessToken,
        accessTokenExpiresIn: this.config.get('JWT_CUSTOMER_ACCESS_TTL_SECONDS'),
        customer: toCustomerProfile(updated),
      },
      refresh,
    };
  }

  /**
   * Step 1 of recovery: Helmet ID + recovery code. Heavily rate-limited. On success returns a
   * short-lived single-use reset token (stored hashed in Redis).
   */
  async recover(
    rawIdentifier: string,
    rawRecoveryCode: string,
    meta: RequestMeta,
  ): Promise<CustomerRecoverResponse> {
    const { key, user } = await this.resolveIdentifier(rawIdentifier, 'customer-recovery');
    const keys = this.lockKeys('customer-recovery', key, user);
    await this.assertNotLocked(
      keys,
      `customer-recovery:ip:${meta.ipHash}`,
      this.config.get('RECOVERY_MAX_FAILURES_PER_IP_PER_HOUR'),
      meta,
    );

    const code = normalizeRecoveryCode(rawRecoveryCode);
    const ok =
      code !== null &&
      (await this.credentials.verifyRecoveryCode(user?.recoveryCodeHash ?? null, code)) &&
      user?.status === 'ACTIVE';
    if (!ok || !user?.recoveryCodeHash) {
      await this.recordFailure(keys, meta, 'recovery', user?.id ?? null);
      throw this.invalidCredentials('The ID or recovery code is incorrect.');
    }
    await Promise.all(keys.map((k) => this.lockout.reset(k)));

    const resetToken = opaqueToken(32);
    const ttl = this.config.get('RECOVERY_RESET_TOKEN_TTL_SECONDS');
    const ticket: ResetTicket = { userId: user.id, recoveryCodeHash: user.recoveryCodeHash };
    await this.redis.set(`customer-reset:${sha(resetToken)}`, JSON.stringify(ticket), 'EX', ttl);
    await this.audit.record({
      action: AuditAction.CUSTOMER_RECOVERY_VERIFIED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      ipHash: meta.ipHash,
    });
    return { resetToken, expiresIn: ttl };
  }

  /**
   * Step 2: set a new password with the reset token. Revokes every session, replaces the
   * recovery code (the old one can never be used again) and signs the customer in.
   */
  async resetPassword(
    resetToken: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<{ session: CustomerSession; recoveryCode: string }> {
    const raw = await this.redis.getdel(`customer-reset:${sha(resetToken)}`);
    if (!raw)
      throw new AppException(
        ErrorCode.RESET_TOKEN_INVALID,
        'This reset link has expired. Start recovery again.',
        HttpStatus.BAD_REQUEST,
      );
    const ticket = JSON.parse(raw) as ResetTicket;
    this.credentials.assertAcceptablePassword(newPassword);

    const [passwordHash, recovery] = await Promise.all([
      this.credentials.hashPassword(newPassword),
      this.credentials.newRecoveryCode(),
    ]);
    // Conditional update makes the recovery code single-use even with parallel reset tokens.
    const updated = await this.prisma.user.updateMany({
      where: { id: ticket.userId, status: 'ACTIVE', recoveryCodeHash: ticket.recoveryCodeHash },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        recoveryCodeHash: recovery.hash,
        recoveryCodeCreatedAt: new Date(),
      },
    });
    if (updated.count !== 1)
      throw new AppException(
        ErrorCode.RESET_TOKEN_INVALID,
        'This reset link is no longer valid. Start recovery again.',
        HttpStatus.BAD_REQUEST,
      );

    await this.tokens.revokeAll(ticket.userId);
    await this.recentAuth.revokeAll('customer', ticket.userId);
    await this.audit.record({
      action: AuditAction.CUSTOMER_PASSWORD_RESET,
      entityType: 'user',
      entityId: ticket.userId,
      userId: ticket.userId,
      ipHash: meta.ipHash,
      metadata: { sessionsRevoked: true, recoveryCodeRotated: true },
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ticket.userId } });
    return { session: await this.startSession(user, meta), recoveryCode: recovery.code };
  }

  async changePassword(
    customer: AuthenticatedCustomer,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    if (!(await this.credentials.verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Your current password is incorrect.',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.credentials.assertAcceptablePassword(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.credentials.hashPassword(newPassword),
        passwordChangedAt: new Date(),
      },
    });
    await this.tokens.revokeAllExcept(user.id, customer.sessionId);
    await this.recentAuth.revokeAll('customer', user.id);
    await this.audit.record({
      action: AuditAction.CUSTOMER_PASSWORD_CHANGED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      ipHash: meta.ipHash,
      metadata: { otherSessionsRevoked: true },
    });
  }

  /** Replaces the recovery code (requires the password). The new code is returned once. */
  async rotateRecoveryCode(
    customer: AuthenticatedCustomer,
    password: string,
    meta: RequestMeta,
  ): Promise<RecoveryCodeIssued> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    if (!(await this.credentials.verifyPassword(user.passwordHash, password))) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Your password is incorrect.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const recovery = await this.credentials.newRecoveryCode();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { recoveryCodeHash: recovery.hash, recoveryCodeCreatedAt: new Date() },
    });
    await this.audit.record({
      action: AuditAction.CUSTOMER_RECOVERY_CODE_ROTATED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      ipHash: meta.ipHash,
    });
    return { recoveryCode: recovery.code };
  }

  async refresh(rawToken: string, meta: RequestMeta): Promise<CustomerSession> {
    const { userId, refresh } = await this.tokens.rotate(rawToken, meta);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const accessToken = await this.tokens.signAccessToken(userId, refresh.familyId);
    return {
      response: {
        accessToken,
        accessTokenExpiresIn: this.config.get('JWT_CUSTOMER_ACCESS_TTL_SECONDS'),
        customer: toCustomerProfile(user),
      },
      refresh,
    };
  }

  async logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!rawToken) return;
    const revoked = await this.tokens.revoke(rawToken);
    if (revoked) {
      await this.audit.recordSafe({
        action: AuditAction.CUSTOMER_LOGOUT,
        entityType: 'user',
        entityId: revoked.subjectId,
        userId: revoked.subjectId,
        ipHash: meta.ipHash,
      });
    }
  }

  async logoutAll(customer: AuthenticatedCustomer, meta: RequestMeta): Promise<void> {
    await this.tokens.revokeAll(customer.id);
    await this.recentAuth.revokeAll('customer', customer.id);
    await this.audit.record({
      action: AuditAction.CUSTOMER_SESSIONS_REVOKED,
      entityType: 'user',
      entityId: customer.id,
      userId: customer.id,
      ipHash: meta.ipHash,
      metadata: { scope: 'all' },
    });
  }

  sessions(customer: AuthenticatedCustomer): Promise<CustomerSessionDto[]> {
    return this.tokens.sessions(customer.id, customer.sessionId);
  }

  async revokeSession(
    customer: AuthenticatedCustomer,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (!(await this.tokens.revokeSession(customer.id, sessionId)))
      throw AppException.notFound(ErrorCode.NOT_FOUND, 'Session not found.');
    await this.audit.record({
      action: AuditAction.CUSTOMER_SESSIONS_REVOKED,
      entityType: 'user',
      entityId: customer.id,
      userId: customer.id,
      ipHash: meta.ipHash,
      metadata: { scope: 'one' },
    });
  }

  async profile(customerId: string): Promise<CustomerProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: customerId } });
    if (!user) throw AppException.notFound(ErrorCode.CUSTOMER_NOT_FOUND, 'Customer not found.');
    return toCustomerProfile(user);
  }

  /** Optional contact details; stored as unverified and never used for auth/recovery. */
  async updateProfile(customerId: string, dto: UpdateCustomerDto): Promise<CustomerProfile> {
    let mobile: string | null | undefined = dto.mobile;
    if (typeof dto.mobile === 'string') {
      mobile = normalizePhone(dto.mobile, this.config.get('DEFAULT_PHONE_REGION'));
      if (!mobile)
        throw new AppException(
          ErrorCode.INVALID_PHONE_NUMBER,
          'Enter a valid mobile number, or leave it empty.',
          HttpStatus.BAD_REQUEST,
        );
    }
    const user = await this.prisma.user.update({
      where: { id: customerId },
      data: {
        name: dto.name,
        email: dto.email,
        mobile,
        ...(dto.email !== undefined ? { emailVerified: false } : {}),
        ...(dto.mobile !== undefined ? { mobileVerified: false } : {}),
      },
    });
    return toCustomerProfile(user);
  }

  /**
   * Resolves a Customer ID (the account itself) or a Helmet ID (its current owner's account).
   * Malformed input / bad check symbols are rejected before any lookup.
   */
  private async resolveIdentifier(
    raw: string,
    _scope: string,
  ): Promise<{ key: string; user: User | null }> {
    const id = parseAccountIdentifier(raw);
    if (!id) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'That ID is not valid. Check the Helmet ID on your label or your Customer ID (CU-…).',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (id.kind === 'customer') {
      const user = await this.prisma.user.findUnique({ where: { customerCode: id.code } });
      return { key: `customer:${sha(id.code)}`, user };
    }
    const ownership = await this.prisma.helmetOwnership.findFirst({
      where: { status: 'ACTIVE', helmet: { helmetCode: id.code } },
      select: { user: true },
    });
    return { key: `helmet:${sha(id.code)}`, user: ownership?.user ?? null };
  }

  /** Per-identifier key always; per-account key too once the account is known. */
  private lockKeys(scope: string, idKey: string, user: User | null): string[] {
    return user ? [`${scope}:${idKey}`, `${scope}:user:${user.id}`] : [`${scope}:${idKey}`];
  }

  private async assertNotLocked(
    keys: string[],
    ipKey: string,
    ipLimit: number,
    meta: RequestMeta,
  ): Promise<void> {
    const [ip, ...states] = await Promise.all([
      meta.ipHash ? this.limiter.peek(ipKey, ipLimit) : Promise.resolve(null),
      ...keys.map((k) => this.lockout.status(k)),
    ]);
    const locked = states.find((s) => s.locked);
    if (locked) throw this.locked(locked.retryAfter);
    if (ip && !ip.allowed) throw this.locked(ip.retryAfter);
  }

  private async recordFailure(
    keys: string[],
    meta: RequestMeta,
    kind: 'login' | 'recovery',
    userId: string | null,
  ): Promise<void> {
    const policy =
      kind === 'login'
        ? {
            threshold: this.config.get('CUSTOMER_LOGIN_FAILURES_BEFORE_LOCK'),
            baseSeconds: this.config.get('CUSTOMER_LOGIN_LOCKOUT_BASE_SECONDS'),
            maxSeconds: this.config.get('CUSTOMER_LOGIN_LOCKOUT_MAX_SECONDS'),
          }
        : {
            threshold: this.config.get('RECOVERY_FAILURES_BEFORE_LOCK'),
            baseSeconds: this.config.get('RECOVERY_LOCKOUT_BASE_SECONDS'),
            maxSeconds: 86_400,
          };
    const states = await Promise.all(keys.map((k) => this.lockout.fail(k, policy)));
    const state = states.find((s) => s.locked) ?? states[0]!;
    if (meta.ipHash) {
      const limit =
        kind === 'login'
          ? this.config.get('CUSTOMER_LOGIN_MAX_FAILURES_PER_IP_PER_HOUR')
          : this.config.get('RECOVERY_MAX_FAILURES_PER_IP_PER_HOUR');
      await this.limiter.hit(`customer-${kind}:ip:${meta.ipHash}`, limit, HOUR);
    }
    // Never record the attempted password or code.
    await this.audit.recordSafe({
      action:
        kind === 'login' ? AuditAction.CUSTOMER_LOGIN_FAILED : AuditAction.CUSTOMER_RECOVERY_FAILED,
      entityType: 'user',
      entityId: userId,
      userId,
      ipHash: meta.ipHash,
      metadata: { failures: state.failures, knownAccount: userId !== null },
    });
    if (state.locked) {
      await this.audit.recordSafe({
        action:
          kind === 'login'
            ? AuditAction.CUSTOMER_LOGIN_LOCKED
            : AuditAction.CUSTOMER_RECOVERY_LOCKED,
        entityType: 'user',
        entityId: userId,
        userId,
        ipHash: meta.ipHash,
        metadata: { failures: state.failures, lockSeconds: state.retryAfter },
      });
    }
  }

  private invalidCredentials(message = 'The ID or password is incorrect.'): AppException {
    return new AppException(ErrorCode.INVALID_CREDENTIALS, message, HttpStatus.UNAUTHORIZED);
  }

  private locked(retryAfter: number): AppException {
    return new AppException(
      ErrorCode.ACCOUNT_LOCKED,
      'Too many attempts. Please wait and try again.',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfter },
    );
  }
}

export function toCustomerProfile(u: User): CustomerProfile {
  return {
    id: u.id,
    customerId: u.customerCode,
    name: u.name,
    email: u.email,
    mobile: u.mobile,
    createdAt: u.createdAt.toISOString(),
  };
}
