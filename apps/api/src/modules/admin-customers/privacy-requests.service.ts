import { HttpStatus, Injectable } from '@nestjs/common';
import type { AccountDeletionRequest } from '@prisma/client';
import { type AdminPrivacyRequestDto, ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RecentAuthService } from '../../security/recent-auth.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import {
  type DeletionAction,
  nextDeletionStatus,
} from '../customer-account/domain/deletion-policy';
import { AdminCustomersService } from './admin-customers.service';

type ReviewAction = Exclude<DeletionAction, 'CANCEL'>;

const INCLUDE = {
  user: { select: { customerCode: true } },
  reviewedBy: { select: { name: true } },
} as const;

type Row = AccountDeletionRequest & {
  user: { customerCode: string };
  reviewedBy: { name: string } | null;
};

function toDto(r: Row): AdminPrivacyRequestDto {
  return {
    id: r.id,
    type: 'ACCOUNT_DELETION',
    customerId: r.user.customerCode,
    status: r.status,
    reason: r.reason,
    reviewNote: r.reviewNote,
    requestedAt: r.requestedAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewedByName: r.reviewedBy?.name ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
  };
}

/**
 * Admin review of customer privacy requests (account deletion). Nothing is erased automatically:
 * COMPLETE marks the account DELETED via the same path as the SUPER_ADMIN "mark deleted" action.
 * Responses never include emergency or medical content.
 */
@Injectable()
export class PrivacyRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: AdminCustomersService,
    private readonly recentAuth: RecentAuthService,
    private readonly audit: AuditService,
  ) {}

  async list(status?: AdminPrivacyRequestDto['status']): Promise<AdminPrivacyRequestDto[]> {
    const rows = await this.prisma.accountDeletionRequest.findMany({
      where: status ? { status } : {},
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: INCLUDE,
    });
    return rows.map(toDto);
  }

  async get(id: string): Promise<AdminPrivacyRequestDto> {
    const row = await this.prisma.accountDeletionRequest.findUnique({
      where: { id },
      include: INCLUDE,
    });
    if (!row)
      throw AppException.notFound(ErrorCode.DELETION_REQUEST_NOT_FOUND, 'Request not found.');
    return toDto(row);
  }

  async review(
    admin: AuthenticatedAdmin,
    id: string,
    action: ReviewAction,
    note: string | undefined,
    recentAuthToken: string | undefined,
    meta: RequestMeta,
  ): Promise<AdminPrivacyRequestDto> {
    if (action === 'COMPLETE')
      await this.recentAuth.assert('admin', admin.id, null, recentAuthToken);
    const request = await this.prisma.accountDeletionRequest.findUnique({
      where: { id },
      include: { user: { select: { id: true, status: true } } },
    });
    if (!request)
      throw AppException.notFound(ErrorCode.DELETION_REQUEST_NOT_FOUND, 'Request not found.');
    const next = nextDeletionStatus(request.status, action);
    if (!next)
      throw new AppException(
        ErrorCode.INVALID_DELETION_TRANSITION,
        `A ${request.status.toLowerCase()} request cannot be ${action.toLowerCase()}d.`,
        HttpStatus.CONFLICT,
      );
    const now = new Date();
    let deleted = false;
    await this.prisma.$transaction(async (tx) => {
      // Conditional: a customer cancelling at the same moment wins or loses cleanly.
      const { count } = await tx.accountDeletionRequest.updateMany({
        where: { id, status: request.status },
        data: {
          status: next,
          reviewedAt: now,
          reviewedByAdminId: admin.id,
          reviewNote: note ?? null,
          ...(next === 'COMPLETED' ? { completedAt: now } : {}),
        },
      });
      if (count !== 1)
        throw new AppException(
          ErrorCode.INVALID_DELETION_TRANSITION,
          'The request changed meanwhile. Reload.',
          HttpStatus.CONFLICT,
        );
      if (next === 'COMPLETED' && request.user.status !== 'DELETED') {
        await this.customers.applyDeletion(
          tx,
          admin,
          request.user.id,
          request.user.status,
          `Deletion request ${id} completed${note ? `: ${note}` : ''}`,
          meta,
        );
        deleted = true;
      }
      await this.audit.record(
        {
          action:
            next === 'COMPLETED'
              ? AuditAction.CUSTOMER_DELETION_COMPLETED
              : AuditAction.CUSTOMER_DELETION_REVIEWED,
          entityType: 'account_deletion_request',
          entityId: id,
          adminId: admin.id,
          userId: request.user.id,
          ipHash: meta.ipHash,
          metadata: { from: request.status, to: next },
        },
        tx,
      );
    });
    if (deleted) await this.customers.afterDeletion(request.user.id);
    return this.get(id);
  }
}
