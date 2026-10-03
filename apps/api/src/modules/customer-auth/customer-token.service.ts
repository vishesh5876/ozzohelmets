import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type CustomerSessionDto, ErrorCode } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  type IssuedRefreshToken,
  RefreshTokenRotator,
  type RefreshTokenStore,
} from '../../security/refresh-token-rotator';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { CUSTOMER_JWT_AUDIENCE, type CustomerJwtPayload } from './customer-auth.types';

@Injectable()
export class CustomerTokenService {
  private readonly logger = new Logger(CustomerTokenService.name);
  private readonly rotator: RefreshTokenRotator;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {
    const table = prisma.customerRefreshToken;
    const store: RefreshTokenStore = {
      findByHash: async (tokenHash) => {
        const row = await table.findUnique({ where: { tokenHash } });
        return (
          row && {
            id: row.id,
            subjectId: row.userId,
            familyId: row.familyId,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            replacedBy: row.replacedBy,
          }
        );
      },
      create: (d) =>
        table.create({
          data: {
            userId: d.subjectId,
            familyId: d.familyId,
            tokenHash: d.tokenHash,
            expiresAt: d.expiresAt,
            userAgent: d.userAgent,
            ipHash: d.ipHash,
          },
          select: { id: true },
        }),
      claim: async (id) =>
        (
          await table.updateMany({
            where: { id, revokedAt: null },
            data: { revokedAt: new Date() },
          })
        ).count === 1,
      setReplacedBy: async (id, replacedBy) =>
        void (await table.update({ where: { id }, data: { replacedBy } })),
      revokeFamily: async (familyId) =>
        void (await table.updateMany({
          where: { familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        })),
      revokeAllForSubject: async (userId) =>
        void (await table.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        })),
    };
    this.rotator = new RefreshTokenRotator(
      store,
      () => this.config.get('CUSTOMER_REFRESH_TTL_DAYS') * 86_400_000,
    );
  }

  signAccessToken(userId: string, sessionId: string): Promise<string> {
    const payload: CustomerJwtPayload = { sub: userId, typ: 'customer', sid: sessionId };
    return this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_CUSTOMER_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_CUSTOMER_ACCESS_TTL_SECONDS'),
      audience: CUSTOMER_JWT_AUDIENCE,
      issuer: this.config.get('JWT_ISSUER'),
      algorithm: 'HS256',
    });
  }

  issueRefreshToken(userId: string, meta: RequestMeta): Promise<IssuedRefreshToken> {
    return this.rotator.issue(userId, meta);
  }

  async rotate(
    rawToken: string,
    meta: RequestMeta,
  ): Promise<{ userId: string; refresh: IssuedRefreshToken }> {
    const result = await this.rotator.rotate(
      rawToken,
      meta,
      async (id) =>
        (await this.prisma.user.findUnique({ where: { id }, select: { status: true } }))?.status ===
        'ACTIVE',
    );
    if (result.ok) return { userId: result.subjectId, refresh: result.refresh };
    if (result.reason === 'REUSED') {
      this.logger.warn(
        `Refresh token reuse detected for customer ${result.subjectId}; family revoked`,
      );
      await this.audit.recordSafe({
        action: AuditAction.CUSTOMER_REFRESH_REUSE_DETECTED,
        entityType: 'user',
        entityId: result.subjectId,
        userId: result.subjectId,
        ipHash: meta.ipHash,
        metadata: { familyId: result.familyId },
      });
      throw AppException.unauthorized(
        ErrorCode.REFRESH_TOKEN_REUSED,
        'Session invalidated. Please sign in again.',
      );
    }
    if (result.reason === 'INACTIVE')
      throw AppException.unauthorized(ErrorCode.ACCOUNT_DISABLED, 'Account is not active.');
    throw AppException.unauthorized(
      ErrorCode.REFRESH_TOKEN_INVALID,
      'Session expired. Please sign in again.',
    );
  }

  revoke(rawToken: string) {
    return this.rotator.revoke(rawToken);
  }

  revokeAll(userId: string): Promise<void> {
    return this.rotator.revokeAllForSubject(userId);
  }

  /** One entry per active login (token family), newest token's metadata. */
  async sessions(userId: string, currentFamilyId: string): Promise<CustomerSessionDto[]> {
    const rows = await this.prisma.customerRefreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const started = await this.prisma.customerRefreshToken.groupBy({
      by: ['familyId'],
      where: { userId, familyId: { in: [...new Set(rows.map((r) => r.familyId))] } },
      _min: { createdAt: true },
    });
    const startedAt = new Map(started.map((g) => [g.familyId, g._min.createdAt]));
    const byFamily = new Map<string, CustomerSessionDto>();
    for (const row of rows) {
      if (byFamily.has(row.familyId)) continue;
      byFamily.set(row.familyId, {
        id: row.familyId,
        userAgent: row.userAgent,
        createdAt: (startedAt.get(row.familyId) ?? row.createdAt).toISOString(),
        lastUsedAt: row.createdAt.toISOString(),
        current: row.familyId === currentFamilyId,
      });
    }
    return [...byFamily.values()];
  }

  /** Revokes one of the customer's own sessions; other users' families are never touched. */
  async revokeSession(userId: string, familyId: string): Promise<boolean> {
    const result = await this.prisma.customerRefreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }
}
