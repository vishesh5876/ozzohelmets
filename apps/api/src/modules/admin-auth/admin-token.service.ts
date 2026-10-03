import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AdminRole } from '@helmet/types';
import { ErrorCode } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { HashingService } from '../../security/hashing.service';
import { opaqueToken } from '../../security/secure-random';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { ADMIN_JWT_AUDIENCE, type AdminJwtPayload } from './admin-auth.types';

/** Window in which presenting an already-rotated token is treated as a benign race. */
const ROTATION_RACE_GRACE_MS = 15_000;

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class AdminTokenService {
  private readonly logger = new Logger(AdminTokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  signAccessToken(adminId: string, role: AdminRole): Promise<string> {
    const payload: AdminJwtPayload = { sub: adminId, role, typ: 'admin' };
    return this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS'),
      audience: ADMIN_JWT_AUDIENCE,
      issuer: this.config.get('JWT_ISSUER'),
      algorithm: 'HS256',
    });
  }

  async issueRefreshToken(
    adminId: string,
    meta: RequestMeta,
    familyId: string = randomUUID(),
  ): Promise<IssuedRefreshToken & { id: string }> {
    const token = opaqueToken(32);
    const expiresAt = new Date(Date.now() + this.config.get('ADMIN_REFRESH_TTL_DAYS') * 86_400_000);
    const row = await this.prisma.adminRefreshToken.create({
      data: {
        adminId,
        familyId,
        tokenHash: this.hashing.sha256(token),
        expiresAt,
        userAgent: meta.userAgent,
        ipHash: meta.ipHash,
      },
      select: { id: true },
    });
    return { id: row.id, token, expiresAt };
  }

  /**
   * Validates and rotates a refresh token. Presenting a token that was already rotated (outside
   * a short race window) is treated as theft: the whole token family is revoked.
   */
  async rotate(
    rawToken: string,
    meta: RequestMeta,
  ): Promise<{ adminId: string; role: AdminRole; refresh: IssuedRefreshToken }> {
    const invalid = () =>
      AppException.unauthorized(
        ErrorCode.REFRESH_TOKEN_INVALID,
        'Session expired. Please sign in again.',
      );
    if (!rawToken || rawToken.length > 128) throw invalid();

    const existing = await this.prisma.adminRefreshToken.findUnique({
      where: { tokenHash: this.hashing.sha256(rawToken) },
      include: { admin: { select: { id: true, role: true, status: true } } },
    });
    if (!existing) throw invalid();

    if (existing.revokedAt) {
      const sinceRevocation = Date.now() - existing.revokedAt.getTime();
      if (existing.replacedBy && sinceRevocation > ROTATION_RACE_GRACE_MS) {
        await this.revokeFamily(existing.familyId);
        this.logger.warn(
          `Refresh token reuse detected for admin ${existing.adminId}; family revoked`,
        );
        await this.audit.recordSafe({
          action: AuditAction.ADMIN_REFRESH_REUSE_DETECTED,
          entityType: 'admin_user',
          entityId: existing.adminId,
          adminId: existing.adminId,
          ipHash: meta.ipHash,
          metadata: { familyId: existing.familyId },
        });
        throw AppException.unauthorized(
          ErrorCode.REFRESH_TOKEN_REUSED,
          'Session invalidated. Please sign in again.',
        );
      }
      throw invalid();
    }
    if (existing.expiresAt.getTime() <= Date.now()) throw invalid();
    if (existing.admin.status !== 'ACTIVE') {
      await this.revokeFamily(existing.familyId);
      throw AppException.unauthorized(ErrorCode.ACCOUNT_DISABLED, 'Account is not active.');
    }

    // Atomic claim: only one concurrent request can rotate a given token.
    const claimed = await this.prisma.adminRefreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw invalid();

    const next = await this.issueRefreshToken(existing.adminId, meta, existing.familyId);
    await this.prisma.adminRefreshToken.update({
      where: { id: existing.id },
      data: { replacedBy: next.id },
    });
    return {
      adminId: existing.adminId,
      role: existing.admin.role,
      refresh: { token: next.token, expiresAt: next.expiresAt },
    };
  }

  /** Revokes the family of the presented token (logout). Unknown tokens are ignored. */
  async revoke(rawToken: string): Promise<string | null> {
    if (!rawToken || rawToken.length > 128) return null;
    const existing = await this.prisma.adminRefreshToken.findUnique({
      where: { tokenHash: this.hashing.sha256(rawToken) },
      select: { familyId: true, adminId: true },
    });
    if (!existing) return null;
    await this.revokeFamily(existing.familyId);
    return existing.adminId;
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.adminRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForAdmin(adminId: string): Promise<void> {
    await this.prisma.adminRefreshToken.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
