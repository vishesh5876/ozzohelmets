import { HttpStatus, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  type CustomerLoginResponse,
  type CustomerProfile,
  type CustomerSessionDto,
  ErrorCode,
  type OtpRequestResponse,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { normalizePhone } from '../../common/utils/phone';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { IssuedRefreshToken } from '../../security/refresh-token-rotator';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { OtpService } from '../otp/otp.service';
import type { AuthenticatedCustomer } from './customer-auth.types';
import { CustomerTokenService } from './customer-token.service';

export interface CustomerSession {
  response: CustomerLoginResponse;
  refresh: IssuedRefreshToken;
}

/**
 * Passwordless customer authentication. Requesting a code never reveals whether an account
 * exists; the account is created (or found) only after the OTP proves possession of the number.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: CustomerTokenService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  normalizeMobile(raw: string): string {
    const mobile = normalizePhone(raw, this.config.get('DEFAULT_PHONE_REGION'));
    if (!mobile)
      throw new AppException(
        ErrorCode.INVALID_PHONE_NUMBER,
        'Enter a valid mobile number.',
        HttpStatus.BAD_REQUEST,
      );
    return mobile;
  }

  async requestOtp(rawMobile: string, meta: RequestMeta): Promise<OtpRequestResponse> {
    const mobile = this.normalizeMobile(rawMobile);
    const issued = await this.otp.issue(mobile, meta.ipHash);
    return {
      sent: true,
      mobile,
      expiresIn: issued.expiresIn,
      resendAfter: issued.resendAfter,
      ...(issued.devOtp ? { devOtp: issued.devOtp } : {}),
    };
  }

  async verifyOtp(rawMobile: string, code: string, meta: RequestMeta): Promise<CustomerSession> {
    const mobile = this.normalizeMobile(rawMobile);
    await this.otp.verify(mobile, code);

    const { user, created } = await this.findOrCreate(mobile);
    if (user.status !== 'ACTIVE')
      throw new AppException(
        ErrorCode.ACCOUNT_DISABLED,
        'This account is not active.',
        HttpStatus.FORBIDDEN,
      );

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), mobileVerified: true },
    });
    const refresh = await this.tokens.issueRefreshToken(user.id, meta);
    const accessToken = await this.tokens.signAccessToken(user.id, refresh.familyId);
    if (created) {
      await this.audit.record({
        action: AuditAction.CUSTOMER_CREATED,
        entityType: 'user',
        entityId: user.id,
        userId: user.id,
        ipHash: meta.ipHash,
        metadata: { via: 'otp' },
      });
    }
    await this.audit.record({
      action: AuditAction.CUSTOMER_LOGIN,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      ipHash: meta.ipHash,
    });

    return {
      response: {
        accessToken,
        accessTokenExpiresIn: this.config.get('JWT_CUSTOMER_ACCESS_TTL_SECONDS'),
        customer: toProfile(updated),
        isNewCustomer: created,
      },
      refresh,
    };
  }

  async refresh(rawToken: string, meta: RequestMeta): Promise<CustomerSession> {
    const { userId, refresh } = await this.tokens.rotate(rawToken, meta);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const accessToken = await this.tokens.signAccessToken(userId, refresh.familyId);
    return {
      response: {
        accessToken,
        accessTokenExpiresIn: this.config.get('JWT_CUSTOMER_ACCESS_TTL_SECONDS'),
        customer: toProfile(user),
        isNewCustomer: false,
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
    const revoked = await this.tokens.revokeSession(customer.id, sessionId);
    if (!revoked) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Session not found.');
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
    return toProfile(user);
  }

  async updateProfile(customerId: string, name: string | undefined): Promise<CustomerProfile> {
    const user = await this.prisma.user.update({ where: { id: customerId }, data: { name } });
    return toProfile(user);
  }

  private async findOrCreate(mobile: string): Promise<{ user: User; created: boolean }> {
    const existing = await this.prisma.user.findUnique({ where: { mobile } });
    if (existing) return { user: existing, created: false };
    try {
      return {
        user: await this.prisma.user.create({ data: { mobile, mobileVerified: true } }),
        created: true,
      };
    } catch (err) {
      // Two simultaneous first logins for the same number: the loser just reads the winner's row.
      if (isUniqueViolation(err))
        return {
          user: await this.prisma.user.findUniqueOrThrow({ where: { mobile } }),
          created: false,
        };
      throw err;
    }
  }
}

function toProfile(u: User): CustomerProfile {
  return {
    id: u.id,
    mobile: u.mobile ?? '',
    name: u.name,
    email: u.email,
    createdAt: u.createdAt.toISOString(),
  };
}
