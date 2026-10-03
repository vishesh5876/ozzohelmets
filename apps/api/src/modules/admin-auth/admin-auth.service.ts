import { Inject, Injectable } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  type AdminLoginResponse,
  type AdminProfile,
  ErrorCode,
  ROLE_PERMISSIONS,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';
import { HashingService } from '../../security/hashing.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { AdminTokenService, type IssuedRefreshToken } from './admin-token.service';

export interface LoginResult {
  response: AdminLoginResponse;
  refresh: IssuedRefreshToken;
}

@Injectable()
export class AdminAuthService {
  /** Lazily computed hash used to equalise timing when the email does not exist. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly tokens: AdminTokenService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const failKey = `admin-login-fail:${this.hashing.sha256(email)}`;
    const maxAttempts = this.config.get('ADMIN_LOGIN_MAX_ATTEMPTS');
    const failures = Number((await this.redis.get(failKey)) ?? 0);
    if (failures >= maxAttempts) {
      await this.audit.recordSafe({
        action: AuditAction.ADMIN_LOGIN_LOCKED,
        entityType: 'admin_user',
        ipHash: meta.ipHash,
        metadata: { emailHash: this.hashing.sha256(email) },
      });
      throw new AppException(
        ErrorCode.ACCOUNT_LOCKED,
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    const valid = admin
      ? await this.hashing.verifyPassword(admin.passwordHash, password)
      : await this.hashing.verifyPassword(await this.getDummyHash(), password).then(() => false);

    if (!admin || !valid) {
      const count = await this.redis.incr(failKey);
      if (count === 1)
        await this.redis.expire(failKey, this.config.get('ADMIN_LOGIN_LOCKOUT_SECONDS'));
      await this.audit.recordSafe({
        action: AuditAction.ADMIN_LOGIN_FAILED,
        entityType: 'admin_user',
        entityId: admin?.id ?? null,
        ipHash: meta.ipHash,
        metadata: { reason: admin ? 'bad_password' : 'unknown_email' },
      });
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid email or password.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (admin.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCode.ACCOUNT_DISABLED,
        'This account is disabled.',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.redis.del(failKey);
    const updated = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });
    const [accessToken, refresh] = await Promise.all([
      this.tokens.signAccessToken(admin.id, admin.role),
      this.tokens.issueRefreshToken(admin.id, meta),
    ]);
    await this.audit.record({
      action: AuditAction.ADMIN_LOGIN_SUCCEEDED,
      entityType: 'admin_user',
      entityId: admin.id,
      adminId: admin.id,
      ipHash: meta.ipHash,
    });

    return {
      response: {
        accessToken,
        accessTokenExpiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS'),
        admin: this.toProfile(updated),
      },
      refresh,
    };
  }

  async refresh(rawToken: string, meta: RequestMeta): Promise<LoginResult> {
    const { adminId, role, refresh } = await this.tokens.rotate(rawToken, meta);
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    const accessToken = await this.tokens.signAccessToken(adminId, role);
    return {
      response: {
        accessToken,
        accessTokenExpiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS'),
        admin: this.toProfile(admin),
      },
      refresh,
    };
  }

  async logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!rawToken) return;
    const adminId = await this.tokens.revoke(rawToken);
    if (adminId) {
      await this.audit.recordSafe({
        action: AuditAction.ADMIN_LOGOUT,
        entityType: 'admin_user',
        entityId: adminId,
        adminId,
        ipHash: meta.ipHash,
      });
    }
  }

  async profile(adminId: string): Promise<AdminProfile> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw AppException.unauthorized();
    return this.toProfile(admin);
  }

  private toProfile(admin: {
    id: string;
    name: string;
    email: string;
    role: AdminProfile['role'];
    lastLoginAt: Date | null;
  }): AdminProfile {
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions: [...ROLE_PERMISSIONS[admin.role]],
      lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hashing.hashPassword('timing-equaliser-not-a-real-password');
    return this.dummyHash;
  }
}
