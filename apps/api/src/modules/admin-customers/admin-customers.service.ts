import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  type AdminCustomerDetailDto,
  type AdminCustomerListItemDto,
  type AdminCustomerSearchResponse,
  type AdminCustomerStatusAction,
  ErrorCode,
  parseAccountIdentifier,
  type RecoveryGrantIssuedDto,
  type UserStatus,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { HashingService } from '../../security/hashing.service';
import { RecentAuthService } from '../../security/recent-auth.service';
import { generateRecoveryGrantCredential } from '../../security/recovery-code';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { toDeletionDto } from '../customer-account/customer-account.service';
import { OPEN_DELETION_STATUSES } from '../customer-account/domain/deletion-policy';
import { CustomerTokenService } from '../customer-auth/customer-token.service';
import { SecurityEventsService } from '../customer-security/security-events.service';
import { EmergencyProfileService } from '../emergency/profile/emergency-profile.service';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { effectiveStatus } from '../warranty/domain/warranty-policy';
import { nextAccountStatus, STATUS_EVENT } from './domain/account-status';
import { likeContains, parseCustomerQuery } from './domain/search';

const DAY_MS = 86_400_000;

/**
 * Customer support for admins. Accounts are addressed by the public Customer ID only. Responses
 * carry operational data — never passwords, hashes, recovery codes, tokens, medical fields or
 * emergency-contact details.
 */
@Injectable()
export class AdminCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: CustomerTokenService,
    private readonly events: SecurityEventsService,
    private readonly recentAuth: RecentAuthService,
    private readonly audit: AuditService,
    private readonly hashing: HashingService,
    private readonly profiles: EmergencyProfileService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly config: AppConfigService,
  ) {}

  // ─────────────── Search ───────────────

  async search(input: {
    q?: string;
    status?: UserStatus;
    page?: number;
    pageSize?: number;
  }): Promise<AdminCustomerSearchResponse> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const query = parseCustomerQuery(input.q);
    if (query.kind === 'tooShort')
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Enter at least 3 characters, a full Customer ID or a full Helmet ID.',
        HttpStatus.BAD_REQUEST,
      );

    let ids: string[];
    let total: number;
    if (query.kind === 'email' || query.kind === 'text') {
      // Raw SQL so the trigram GIN indexes on lower(email_normalized) / lower(name) are used.
      const pattern = likeContains(query.fragment);
      const match =
        query.kind === 'email'
          ? Prisma.sql`lower(email_normalized) LIKE ${pattern}`
          : Prisma.sql`(lower(email_normalized) LIKE ${pattern} OR lower(name) LIKE ${pattern})`;
      const status = input.status
        ? Prisma.sql`AND status = ${input.status}::"UserStatus"`
        : Prisma.empty;
      const [rows, counted] = await Promise.all([
        this.prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM users WHERE ${match} ${status}
          ORDER BY created_at DESC, id DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        this.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM users WHERE ${match} ${status}`,
      ]);
      ids = rows.map((r) => r.id);
      total = Number(counted[0]?.n ?? 0);
    } else {
      const where: Prisma.UserWhereInput = {
        ...(input.status ? { status: input.status } : {}),
        ...(query.kind === 'customerId' ? { customerCode: query.code } : {}),
        ...(query.kind === 'helmetId'
          ? { ownerships: { some: { status: 'ACTIVE', helmet: { helmetCode: query.code } } } }
          : {}),
      };
      const [rows, count] = await Promise.all([
        this.prisma.user.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true },
        }),
        this.prisma.user.count({ where }),
      ]);
      ids = rows.map((r) => r.id);
      total = count;
    }
    return {
      items: await this.listItems(ids),
      total,
      page,
      pageSize,
      matchedBy: query.kind,
    };
  }

  /** Users + active-helmet counts in two queries (no N+1), preserving the given order. */
  private async listItems(ids: string[]): Promise<AdminCustomerListItemDto[]> {
    if (ids.length === 0) return [];
    const [users, counts] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          customerCode: true,
          name: true,
          email: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
      this.prisma.helmetOwnership.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const helmetCount = new Map(counts.map((c) => [c.userId, c._count._all]));
    return ids.flatMap((id) => {
      const u = byId.get(id);
      return u
        ? [
            {
              customerId: u.customerCode,
              name: u.name,
              email: u.email,
              status: u.status,
              activeHelmets: helmetCount.get(id) ?? 0,
              createdAt: u.createdAt.toISOString(),
              lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
            },
          ]
        : [];
    });
  }

  // ─────────────── Detail ───────────────

  async detail(
    admin: AuthenticatedAdmin,
    customerId: string,
    meta: RequestMeta,
  ): Promise<AdminCustomerDetailDto> {
    const user = await this.findByCustomerId(customerId);
    const userId = user.id;
    const since30d = new Date(Date.now() - 30 * DAY_MS);
    const [
      activeSessions,
      owned,
      history,
      warrantyCount,
      profile,
      contactCount,
      openGrant,
      lastUsedGrant,
      loginBlocks30d,
      lastEvent,
      deletion,
    ] = await Promise.all([
      this.tokens.activeSessionCount(userId),
      this.prisma.helmetOwnership.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: { activatedAt: 'desc' },
        select: {
          activatedAt: true,
          helmet: {
            select: {
              id: true,
              helmetCode: true,
              status: true,
              helmetModel: { select: { name: true } },
              emergencySettings: { where: { userId }, select: { enabled: true } },
              warranty: { select: { status: true, warrantyEndDate: true } },
            },
          },
        },
      }),
      this.prisma.helmetOwnership.findMany({
        where: { userId },
        orderBy: { activatedAt: 'desc' },
        take: 50,
        select: {
          status: true,
          acquiredVia: true,
          activatedAt: true,
          endedAt: true,
          helmet: { select: { id: true, helmetCode: true } },
        },
      }),
      this.prisma.helmetWarranty.count({ where: { registeredByUserId: userId } }),
      this.prisma.emergencyProfile.findFirst({
        where: { userId, helmetId: null },
        select: { emergencyProfileEnabled: true },
      }),
      this.prisma.emergencyContact.count({ where: { userId, isActive: true } }),
      this.prisma.accountRecoveryGrant.findFirst({
        where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { expiresAt: true },
      }),
      this.prisma.accountRecoveryGrant.findFirst({
        where: { userId, usedAt: { not: null } },
        orderBy: { usedAt: 'desc' },
        select: { usedAt: true },
      }),
      this.prisma.customerSecurityEvent.count({
        where: { userId, type: 'LOGIN_FAILURE_THRESHOLD', createdAt: { gte: since30d } },
      }),
      this.prisma.customerSecurityEvent.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.accountDeletionRequest.findFirst({
        where: { userId },
        orderBy: { requestedAt: 'desc' },
      }),
    ]);
    // Viewing an account summary is itself recorded (support access to personal data).
    await this.audit.recordSafe({
      action: AuditAction.CUSTOMER_VIEWED,
      entityType: 'user',
      entityId: userId,
      adminId: admin.id,
      userId,
      ipHash: meta.ipHash,
    });
    return {
      customerId: user.customerCode,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      mobile: user.mobile,
      status: user.status,
      statusChangedAt: user.statusChangedAt?.toISOString() ?? null,
      statusReason: user.statusReason,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      activeSessions,
      helmets: owned.map(({ helmet, activatedAt }) => ({
        id: helmet.id,
        helmetCode: helmet.helmetCode,
        modelName: helmet.helmetModel.name,
        status: helmet.status,
        ownedSince: activatedAt.toISOString(),
        emergencySharing: helmet.emergencySettings[0]?.enabled ?? false,
        warrantyStatus: effectiveStatus(helmet.warranty),
      })),
      ownershipHistory: history.map((o) => ({
        helmetId: o.helmet.id,
        helmetCode: o.helmet.helmetCode,
        status: o.status,
        acquiredVia: o.acquiredVia,
        from: o.activatedAt.toISOString(),
        until: o.endedAt?.toISOString() ?? null,
      })),
      warrantyCount,
      emergency: {
        configured: profile !== null,
        enabled: profile?.emergencyProfileEnabled ?? false,
        contactCount,
      },
      recovery: {
        recoveryCodeConfigured: user.recoveryCodeHash !== null,
        recoveryCodeAcknowledged: user.recoveryCodeAcknowledgedAt !== null,
        recoveryCodeCreatedAt: user.recoveryCodeCreatedAt?.toISOString() ?? null,
        openGrantExpiresAt: openGrant?.expiresAt.toISOString() ?? null,
        lastGrantUsedAt: lastUsedGrant?.usedAt?.toISOString() ?? null,
      },
      security: {
        passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null,
        loginBlocks30d,
        lastSecurityEventAt: lastEvent?.createdAt.toISOString() ?? null,
      },
      deletionRequest: deletion ? toDeletionDto(deletion) : null,
    };
  }

  // ─────────────── Status & sessions ───────────────

  async changeStatus(
    admin: AuthenticatedAdmin,
    customerId: string,
    action: AdminCustomerStatusAction,
    reason: string,
    meta: RequestMeta,
  ): Promise<AdminCustomerDetailDto> {
    const user = await this.findByCustomerId(customerId);
    const next = nextAccountStatus(user.status, action);
    if (!next)
      throw AppException.conflict(
        ErrorCode.INVALID_STATUS_CHANGE,
        `An account that is ${user.status.toLowerCase()} cannot be changed with ${action.toLowerCase()}.`,
      );
    // Conditional update: two support agents acting at once can't both apply a change.
    const { count } = await this.prisma.user.updateMany({
      where: { id: user.id, status: user.status },
      data: { status: next, statusChangedAt: new Date(), statusReason: reason },
    });
    if (count !== 1)
      throw AppException.conflict(ErrorCode.CONFLICT, 'The account changed meanwhile. Reload.');
    if (next !== 'ACTIVE') {
      // Suspension/lock ends every session at once (refresh tokens + live access tokens).
      await this.tokens.revokeAll(user.id);
      await this.recentAuth.revokeAll('customer', user.id);
    }
    await this.audit.record({
      action: AuditAction.CUSTOMER_STATUS_CHANGED,
      entityType: 'user',
      entityId: user.id,
      adminId: admin.id,
      userId: user.id,
      ipHash: meta.ipHash,
      metadata: { from: user.status, to: next, action },
    });
    await this.events.record(user.id, STATUS_EVENT[action]);
    return this.detail(admin, customerId, meta);
  }

  async forceLogout(
    admin: AuthenticatedAdmin,
    customerId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ revoked: true }> {
    const user = await this.findByCustomerId(customerId);
    await this.tokens.revokeAll(user.id);
    await this.recentAuth.revokeAll('customer', user.id);
    await this.audit.record({
      action: AuditAction.CUSTOMER_FORCED_LOGOUT,
      entityType: 'user',
      entityId: user.id,
      adminId: admin.id,
      userId: user.id,
      ipHash: meta.ipHash,
      metadata: { reasonGiven: reason.length > 0 },
    });
    await this.events.record(user.id, 'ALL_SESSIONS_REVOKED');
    return { revoked: true };
  }

  // ─────────────── Mark deleted (SUPER_ADMIN) ───────────────

  async markDeleted(
    admin: AuthenticatedAdmin,
    customerId: string,
    input: { reason: string; confirmCustomerId: string },
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<AdminCustomerDetailDto> {
    await this.recentAuth.assert('admin', admin.id, null, recentAuthToken);
    const user = await this.findByCustomerId(customerId);
    this.assertConfirmed(user.customerCode, input.confirmCustomerId);
    if (user.status === 'DELETED')
      throw AppException.conflict(
        ErrorCode.INVALID_STATUS_CHANGE,
        'The account is already deleted.',
      );
    await this.prisma.$transaction((tx) =>
      this.applyDeletion(tx, admin, user.id, user.status, input.reason, meta),
    );
    await this.afterDeletion(user.id);
    return this.detail(admin, customerId, meta);
  }

  /**
   * Marks an account DELETED inside a transaction. Nothing is erased: ownership, warranty and audit
   * records are retained; emergency sharing is switched off, open recovery grants revoked, open
   * deletion requests completed, and the email released (the unique index ignores DELETED).
   * Call `afterDeletion` after commit.
   */
  async applyDeletion(
    tx: PrismaTx,
    admin: AuthenticatedAdmin,
    userId: string,
    fromStatus: UserStatus,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    const now = new Date();
    const { count } = await tx.user.updateMany({
      where: { id: userId, status: fromStatus },
      data: { status: 'DELETED', statusChangedAt: now, statusReason: reason.slice(0, 300) },
    });
    if (count !== 1)
      throw AppException.conflict(ErrorCode.CONFLICT, 'The account changed meanwhile. Reload.');
    const helmetsDeactivated = await this.profiles.switchOffAllSharing(
      tx,
      userId,
      { type: ActorType.ADMIN, id: admin.id },
      'Account deleted',
    );
    await tx.accountRecoveryGrant.updateMany({
      where: { userId, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.accountDeletionRequest.updateMany({
      where: { userId, status: { in: [...OPEN_DELETION_STATUSES] } },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        reviewedAt: now,
        reviewedByAdminId: admin.id,
      },
    });
    await this.audit.record(
      {
        action: AuditAction.CUSTOMER_DELETED,
        entityType: 'user',
        entityId: userId,
        adminId: admin.id,
        userId,
        ipHash: meta.ipHash,
        metadata: { from: fromStatus, helmetsDeactivated },
      },
      tx,
    );
    await this.events.record(userId, 'ACCOUNT_DELETED', {}, tx);
  }

  async afterDeletion(userId: string): Promise<void> {
    await this.tokens.revokeAll(userId);
    await this.recentAuth.revokeAll('customer', userId);
    await this.cache.invalidateForOwner(userId);
  }

  // ─────────────── Account Recovery Grant (SUPER_ADMIN) ───────────────

  /**
   * Last-resort recovery when the customer lost both password and recovery code. Requires the
   * admin's recent password, a reason and the Customer ID typed again. The credential is returned
   * once; only an Argon2id hash is stored; it is single use and short-lived, and it replaces any
   * earlier open grant. Never emailed automatically — support hands it over out of band after
   * verifying the customer's identity (see ACCOUNT-RECOVERY.md).
   */
  async issueRecoveryGrant(
    admin: AuthenticatedAdmin,
    customerId: string,
    input: { reason: string; confirmCustomerId: string },
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<RecoveryGrantIssuedDto> {
    await this.recentAuth.assert('admin', admin.id, null, recentAuthToken);
    const user = await this.findByCustomerId(customerId);
    this.assertConfirmed(user.customerCode, input.confirmCustomerId);
    if (user.status !== 'ACTIVE')
      throw AppException.conflict(
        ErrorCode.CUSTOMER_NOT_ACTIVE,
        'Restore the account before issuing a recovery grant.',
      );
    const credential = generateRecoveryGrantCredential();
    const credentialHash = await this.hashing.hashCustomerSecret(credential);
    const expiresAt = new Date(Date.now() + this.config.get('RECOVERY_GRANT_TTL_MINUTES') * 60_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.accountRecoveryGrant.updateMany({
        where: { userId: user.id, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const grant = await tx.accountRecoveryGrant.create({
        data: {
          userId: user.id,
          credentialHash,
          issuedByAdminId: admin.id,
          reason: input.reason,
          expiresAt,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: AuditAction.CUSTOMER_RECOVERY_GRANT_ISSUED,
          entityType: 'account_recovery_grant',
          entityId: grant.id,
          adminId: admin.id,
          userId: user.id,
          ipHash: meta.ipHash,
          // Never the credential or its hash.
          metadata: { customerId: user.customerCode, expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
      await this.events.record(user.id, 'ACCOUNT_RECOVERY_GRANT_ISSUED', {}, tx);
    });
    return { customerId: user.customerCode, credential, expiresAt: expiresAt.toISOString() };
  }

  async revokeRecoveryGrant(
    admin: AuthenticatedAdmin,
    customerId: string,
    meta: RequestMeta,
  ): Promise<{ revoked: boolean }> {
    const user = await this.findByCustomerId(customerId);
    const { count } = await this.prisma.accountRecoveryGrant.updateMany({
      where: { userId: user.id, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0)
      await this.audit.record({
        action: AuditAction.CUSTOMER_RECOVERY_GRANT_REVOKED,
        entityType: 'user',
        entityId: user.id,
        adminId: admin.id,
        userId: user.id,
        ipHash: meta.ipHash,
      });
    return { revoked: count > 0 };
  }

  // ─────────────── Helpers ───────────────

  async findByCustomerId(raw: string) {
    const id = parseAccountIdentifier(raw);
    const user =
      id?.kind === 'customer'
        ? await this.prisma.user.findUnique({ where: { customerCode: id.code } })
        : null;
    if (!user) throw AppException.notFound(ErrorCode.CUSTOMER_NOT_FOUND, 'Customer not found.');
    return user;
  }

  private assertConfirmed(customerCode: string, typed: string): void {
    const id = parseAccountIdentifier(typed);
    if (id?.kind !== 'customer' || id.code !== customerCode)
      throw new AppException(
        ErrorCode.CONFIRMATION_MISMATCH,
        'Type the Customer ID exactly to confirm.',
        HttpStatus.BAD_REQUEST,
      );
  }
}
