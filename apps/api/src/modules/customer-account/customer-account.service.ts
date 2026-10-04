import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AccountDeletionRequestDto,
  type CustomerDataExportDto,
  type CustomerHelmetDto,
  type CustomerSecurityEventDto,
  type CustomerSecurityStatusDto,
  type CustomerWarrantySummaryDto,
  type EmergencyReadinessDto,
  ErrorCode,
  type HealthWarningDto,
  type ProfileCompletionDto,
} from '@helmet/types';
import type { AccountDeletionRequest } from '@prisma/client';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RecentAuthService } from '../../security/recent-auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { CustomerTokenService } from '../customer-auth/customer-token.service';
import { SecurityEventsService } from '../customer-security/security-events.service';
import { EmergencyProfileService } from '../emergency/profile/emergency-profile.service';
import { effectiveStatus } from '../warranty/domain/warranty-policy';
import { nextDeletionStatus, OPEN_DELETION_STATUSES } from './domain/deletion-policy';
import { buildCustomerExport } from './domain/export';
import { evaluateCompletion, evaluateHealth } from './domain/health';

export function toDeletionDto(r: AccountDeletionRequest): AccountDeletionRequestDto {
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    requestedAt: r.requestedAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
  };
}

/**
 * The customer's own account surface beyond sign-in: security status, activity, dashboard health,
 * profile completion, data export and deletion requests. Everything is scoped by the
 * authenticated customer's id; nothing here accepts a user id from the client.
 */
@Injectable()
export class CustomerAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: CustomerTokenService,
    private readonly events: SecurityEventsService,
    private readonly recentAuth: RecentAuthService,
    private readonly audit: AuditService,
    private readonly profiles: EmergencyProfileService,
  ) {}

  async securityStatus(userId: string): Promise<CustomerSecurityStatusDto> {
    const [user, activeSessions] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          email: true,
          recoveryCodeHash: true,
          recoveryCodeCreatedAt: true,
          recoveryCodeAcknowledgedAt: true,
          passwordChangedAt: true,
          lastLoginAt: true,
        },
      }),
      this.tokens.activeSessionCount(userId),
    ]);
    return {
      email: user.email,
      recoveryCodeConfigured: user.recoveryCodeHash !== null,
      recoveryCodeAcknowledged: user.recoveryCodeAcknowledgedAt !== null,
      recoveryCodeCreatedAt: user.recoveryCodeCreatedAt?.toISOString() ?? null,
      passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null,
      activeSessions,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }

  activity(userId: string, limit = 50): Promise<CustomerSecurityEventDto[]> {
    return this.events.forCustomer(userId, limit);
  }

  async completion(userId: string): Promise<ProfileCompletionDto> {
    const [profile, contacts, visibility, sharing] = await Promise.all([
      this.prisma.emergencyProfile.findFirst({
        where: { userId, helmetId: null },
        select: {
          name: true,
          bloodGroup: true,
          medicalConditionsCiphertext: true,
          allergiesCiphertext: true,
          medicationsCiphertext: true,
          emergencyProfileEnabled: true,
        },
      }),
      this.prisma.emergencyContact.count({ where: { userId, isActive: true } }),
      this.prisma.emergencyVisibility.findUnique({
        where: { userId },
        select: { confirmedAt: true },
      }),
      this.prisma.helmetEmergencySetting.count({
        where: {
          userId,
          enabled: true,
          helmet: { ownerships: { some: { userId, status: 'ACTIVE' } } },
        },
      }),
    ]);
    return evaluateCompletion({
      name: profile?.name ?? null,
      bloodGroup: profile?.bloodGroup ?? null,
      hasMedicalConditions: !!profile?.medicalConditionsCiphertext,
      hasAllergies: !!profile?.allergiesCiphertext,
      hasMedications: !!profile?.medicationsCiphertext,
      activeContactCount: contacts,
      privacyConfirmed: visibility?.confirmedAt != null,
      sharingOnAnyHelmet: !!profile?.emergencyProfileEnabled && sharing > 0,
    });
  }

  /** Phase 5 dashboard additions, computed from data the dashboard already loaded. */
  async dashboardExtras(
    userId: string,
    helmets: CustomerHelmetDto[],
    readiness: EmergencyReadinessDto,
    contactCount: number,
  ): Promise<{
    completion: ProfileCompletionDto;
    health: HealthWarningDto[];
    security: CustomerSecurityStatusDto;
    warranty: CustomerWarrantySummaryDto;
    recentActivity: CustomerSecurityEventDto[];
  }> {
    const [completion, security, recentActivity, deletion] = await Promise.all([
      this.completion(userId),
      this.securityStatus(userId),
      this.events.forCustomer(userId, 5),
      this.prisma.accountDeletionRequest.findFirst({
        where: { userId, status: { in: [...OPEN_DELETION_STATUSES] } },
        select: { id: true },
      }),
    ]);
    const warranty: CustomerWarrantySummaryDto = { active: 0, expired: 0, notRegistered: 0 };
    for (const h of helmets) {
      if (h.warranty.status === 'ACTIVE') warranty.active++;
      else if (h.warranty.status === 'EXPIRED') warranty.expired++;
      else if (h.warranty.status === 'NOT_REGISTERED') warranty.notRegistered++;
    }
    const health = evaluateHealth({
      helmets,
      readiness,
      contactCount,
      security,
      deletionRequested: deletion !== null,
    });
    return { completion, health, security, warranty, recentActivity };
  }

  // ─────────────── Data export ───────────────

  /** JSON export of the customer's own data. Requires a recent password confirmation. */
  async exportData(
    customer: AuthenticatedCustomer,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<CustomerDataExportDto> {
    await this.recentAuth.assert('customer', customer.id, customer.sessionId, recentAuthToken);
    const userId = customer.id;
    const [user, owned, ownerships, profile, contacts, visibility, warranties, events, deletions] =
      await Promise.all([
        this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
        this.prisma.helmetOwnership.findMany({
          where: { userId, status: 'ACTIVE' },
          select: {
            helmet: {
              select: {
                id: true,
                helmetCode: true,
                status: true,
                helmetModel: { select: { name: true, brand: true } },
                emergencySettings: { where: { userId }, select: { enabled: true } },
              },
            },
          },
        }),
        this.prisma.helmetOwnership.findMany({
          where: { userId },
          orderBy: { activatedAt: 'asc' },
          select: {
            status: true,
            acquiredVia: true,
            activatedAt: true,
            endedAt: true,
            helmet: { select: { helmetCode: true } },
          },
        }),
        this.profiles.loadDecrypted(userId),
        this.prisma.emergencyContact.findMany({
          where: { userId, isActive: true },
          orderBy: { priority: 'asc' },
        }),
        this.prisma.emergencyVisibility.findUnique({ where: { userId } }),
        this.prisma.helmetWarranty.findMany({
          where: {
            OR: [
              { registeredByUserId: userId },
              { helmet: { ownerships: { some: { userId, status: 'ACTIVE' } } } },
            ],
          },
          include: { helmet: { select: { helmetCode: true } } },
        }),
        this.prisma.customerSecurityEvent.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 500,
        }),
        this.prisma.accountDeletionRequest.findMany({
          where: { userId },
          orderBy: { requestedAt: 'desc' },
        }),
      ]);
    const result = buildCustomerExport({
      user,
      helmets: owned.map(({ helmet }) => ({
        helmetCode: helmet.helmetCode,
        model: helmet.helmetModel.name,
        brand: helmet.helmetModel.brand,
        status: helmet.status,
        emergencySharing: helmet.emergencySettings[0]?.enabled ?? false,
      })),
      ownerships: ownerships.map((o) => ({
        helmetCode: o.helmet.helmetCode,
        status: o.status,
        acquiredVia: o.acquiredVia,
        from: o.activatedAt,
        until: o.endedAt,
      })),
      profile,
      contacts,
      visibility: visibility as unknown as Record<string, unknown> | null,
      warranties: warranties.map((w) => ({
        helmetCode: w.helmet.helmetCode,
        status: effectiveStatus(w),
        purchaseDate: w.purchaseDate,
        startDate: w.warrantyStartDate,
        endDate: w.warrantyEndDate,
        isRegistrant: w.registeredByUserId === userId,
        sellerName: w.sellerName,
        invoiceNumber: w.invoiceNumber,
      })),
      events,
      deletionRequests: deletions.map(toDeletionDto),
    });
    await this.audit.record({
      action: AuditAction.CUSTOMER_DATA_EXPORTED,
      entityType: 'user',
      entityId: userId,
      userId,
      ipHash: meta.ipHash,
    });
    await this.events.record(userId, 'DATA_EXPORTED', { ...meta, sessionId: customer.sessionId });
    return result;
  }

  // ─────────────── Deletion requests ───────────────

  async deletionRequest(userId: string): Promise<AccountDeletionRequestDto | null> {
    const row = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
    });
    return row ? toDeletionDto(row) : null;
  }

  async requestDeletion(
    customer: AuthenticatedCustomer,
    reason: string | undefined,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<AccountDeletionRequestDto> {
    await this.recentAuth.assert('customer', customer.id, customer.sessionId, recentAuthToken);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const open = await tx.accountDeletionRequest.findFirst({
          where: { userId: customer.id, status: { in: [...OPEN_DELETION_STATUSES] } },
          select: { id: true },
        });
        if (open) throw this.exists();
        const created = await tx.accountDeletionRequest.create({
          data: { userId: customer.id, reason: reason?.trim() || null },
        });
        await this.audit.record(
          {
            action: AuditAction.CUSTOMER_DELETION_REQUESTED,
            entityType: 'account_deletion_request',
            entityId: created.id,
            userId: customer.id,
            ipHash: meta.ipHash,
          },
          tx,
        );
        return created;
      });
      await this.events.record(customer.id, 'DELETION_REQUESTED', {
        ...meta,
        sessionId: customer.sessionId,
      });
      return toDeletionDto(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw this.exists();
      throw err;
    }
  }

  async cancelDeletion(
    customer: AuthenticatedCustomer,
    meta: RequestMeta,
  ): Promise<AccountDeletionRequestDto> {
    const open = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId: customer.id, status: { in: [...OPEN_DELETION_STATUSES] } },
    });
    if (!open)
      throw AppException.notFound(
        ErrorCode.DELETION_REQUEST_NOT_FOUND,
        'There is no open deletion request.',
      );
    const next = nextDeletionStatus(open.status, 'CANCEL');
    if (!next) throw this.invalidTransition();
    // Conditional update: a concurrent admin completion wins and the cancel is refused.
    const { count } = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: open.id, status: open.status },
      data: { status: next, cancelledAt: new Date() },
    });
    if (count !== 1) throw this.invalidTransition();
    await this.audit.record({
      action: AuditAction.CUSTOMER_DELETION_CANCELLED,
      entityType: 'account_deletion_request',
      entityId: open.id,
      userId: customer.id,
      ipHash: meta.ipHash,
    });
    await this.events.record(customer.id, 'DELETION_CANCELLED', {
      ...meta,
      sessionId: customer.sessionId,
    });
    return toDeletionDto(
      await this.prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id: open.id } }),
    );
  }

  private exists(): AppException {
    return new AppException(
      ErrorCode.DELETION_REQUEST_EXISTS,
      'You already have an open deletion request.',
      HttpStatus.CONFLICT,
    );
  }

  private invalidTransition(): AppException {
    return new AppException(
      ErrorCode.INVALID_DELETION_TRANSITION,
      'This request can no longer be changed.',
      HttpStatus.CONFLICT,
    );
  }
}
