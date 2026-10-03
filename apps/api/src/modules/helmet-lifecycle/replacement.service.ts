import { Injectable } from '@nestjs/common';
import {
  ActorType,
  ErrorCode,
  type HelmetReplacementLinksDto,
  type HelmetStatus,
  OPERATIONAL_STATUSES,
  type ReplacementLinkDto,
  type ReplacementReason,
} from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { CustomerCredentialsService } from '../customer-auth/customer-credentials.service';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { OwnedHelmetLocker } from '../helmets/domain/owned-helmet.locker';
import { WarrantyService } from '../warranty/warranty.service';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';

/** Statuses from which an original helmet may be marked REPLACED. */
const REPLACEABLE: readonly HelmetStatus[] = [
  'ACTIVATED',
  'ACTIVE',
  'LOST',
  'STOLEN',
  'DAMAGED',
  'RECALLED',
];

const MAX_CHAIN = 50;

export interface LinkReplacementInput {
  originalHelmetId: string;
  replacementHelmetCode: string;
  reason: ReplacementReason;
  notes?: string;
  /** Admin override for the replacement's warranty end date (YYYY-MM-DD). */
  replacementWarrantyEndDate?: string;
}

/**
 * Links a physically different helmet as the replacement of another. Identities are never
 * reused or copied: the replacement keeps its own Helmet ID, QR, PIN and serial and must already
 * be activated normally (with its own PIN) by the SAME customer. The original becomes REPLACED.
 * The emergency profile is the customer's; the replacement only exposes it after the customer
 * explicitly switches it on for that helmet.
 */
@Injectable()
export class ReplacementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locker: OwnedHelmetLocker,
    private readonly statuses: HelmetStatusService,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly credentials: CustomerCredentialsService,
    private readonly warranties: WarrantyService,
  ) {}

  async link(
    admin: AuthenticatedAdmin,
    input: LinkReplacementInput,
    meta: RequestMeta,
  ): Promise<HelmetReplacementLinksDto> {
    const replacementCode = this.credentials.canonicalHelmetCode(input.replacementHelmetCode);
    const replacementRow = await this.prisma.helmet.findUnique({
      where: { helmetCode: replacementCode },
      select: { id: true },
    });
    if (!replacementRow) throw this.invalid('The replacement Helmet ID was not found.');
    if (replacementRow.id === input.originalHelmetId) {
      throw this.invalid('A helmet cannot replace itself.');
    }

    const [publicToken, replacementToken] = await this.prisma.$transaction(async (tx) => {
      // Lock both helmets in a stable order (by id) so concurrent links can't deadlock.
      const [firstId, secondId] = [input.originalHelmetId, replacementRow.id].sort();
      const first = await this.locker.lock(tx, { id: firstId! });
      const second = await this.locker.lock(tx, { id: secondId! });
      const original = first?.helmet.id === input.originalHelmetId ? first : second;
      const replacement = first?.helmet.id === input.originalHelmetId ? second : first;
      if (!original) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
      if (!replacement) throw this.invalid('The replacement Helmet ID was not found.');

      if (!original.ownership) throw this.invalid('The original helmet has no current owner.');
      if (!REPLACEABLE.includes(original.helmet.status)) {
        throw this.invalid('The original helmet cannot be replaced in its current state.');
      }
      if (!replacement.ownership || replacement.ownership.userId !== original.ownership.userId) {
        throw this.invalid(
          'The replacement helmet must first be activated with its own PIN by the same customer.',
        );
      }
      if (!OPERATIONAL_STATUSES.includes(replacement.helmet.status)) {
        throw this.invalid('The replacement helmet must be in normal use (activated).');
      }
      const existing = await tx.helmetReplacement.findFirst({
        where: {
          OR: [
            { originalHelmetId: original.helmet.id },
            { replacementHelmetId: replacement.helmet.id },
          ],
        },
        select: { id: true },
      });
      if (existing) throw this.invalid('One of these helmets is already part of a replacement.');
      if (await this.isAncestor(tx, replacement.helmet.id, original.helmet.id)) {
        throw this.invalid('This link would create a replacement cycle.');
      }

      const link = await tx.helmetReplacement.create({
        data: {
          originalHelmetId: original.helmet.id,
          replacementHelmetId: replacement.helmet.id,
          reason: input.reason,
          notes: input.notes?.trim() || null,
          createdByAdminId: admin.id,
        },
      });
      await this.statuses.apply(tx, {
        helmetId: original.helmet.id,
        from: original.helmet.status,
        to: 'REPLACED',
        actor: { type: ActorType.ADMIN, id: admin.id },
        reason: `Replaced by ${replacement.helmet.helmetCode}`,
        reasonCode: `REPLACED:${input.reason}`,
      });
      await tx.helmetEmergencySetting.updateMany({
        where: { helmetId: original.helmet.id },
        data: { enabled: false },
      });
      // Replacement warranty policy (original → REPLACED; replacement gets its own coverage).
      await this.warranties.applyReplacement(
        tx,
        {
          originalHelmetId: original.helmet.id,
          replacementHelmetId: replacement.helmet.id,
          replacementHelmetCode: replacement.helmet.helmetCode,
          ownerUserId: original.ownership.userId,
          adminId: admin.id,
          overrideEndDate: input.replacementWarrantyEndDate,
        },
        meta,
      );
      await this.audit.record(
        {
          action: AuditAction.HELMET_REPLACEMENT_LINKED,
          entityType: 'helmet',
          entityId: original.helmet.id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: {
            replacementId: link.id,
            replacementHelmetId: replacement.helmet.id,
            reason: input.reason,
            fromStatus: original.helmet.status,
          },
        },
        tx,
      );
      return [original.helmet.publicToken, replacement.helmet.publicToken] as const;
    });
    await this.cache.invalidate(publicToken, replacementToken);
    return this.links(input.originalHelmetId);
  }

  async links(helmetId: string): Promise<HelmetReplacementLinksDto> {
    const rows = await this.prisma.helmetReplacement.findMany({
      where: { OR: [{ originalHelmetId: helmetId }, { replacementHelmetId: helmetId }] },
      include: {
        original: { select: { id: true, helmetCode: true } },
        replacement: { select: { id: true, helmetCode: true } },
        createdBy: { select: { name: true } },
      },
    });
    const toDto = (
      r: (typeof rows)[number],
      other: { id: string; helmetCode: string },
    ): ReplacementLinkDto => ({
      id: r.id,
      helmetId: other.id,
      helmetCode: other.helmetCode,
      reason: r.reason,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      createdByAdminName: r.createdBy?.name ?? null,
    });
    const replacedBy = rows.find((r) => r.originalHelmetId === helmetId);
    const replaces = rows.find((r) => r.replacementHelmetId === helmetId);
    return {
      replacedBy: replacedBy ? toDto(replacedBy, replacedBy.replacement) : null,
      replaces: replaces ? toDto(replaces, replaces.original) : null,
    };
  }

  /** True if `candidate` appears in the chain of helmets that `helmetId` replaced. */
  private async isAncestor(tx: PrismaTx, candidate: string, helmetId: string): Promise<boolean> {
    let current = helmetId;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const link = await tx.helmetReplacement.findUnique({
        where: { replacementHelmetId: current },
        select: { originalHelmetId: true },
      });
      if (!link) return false;
      if (link.originalHelmetId === candidate) return true;
      current = link.originalHelmetId;
    }
    return true; // pathological chain length: refuse rather than risk a cycle
  }

  private invalid(message: string): AppException {
    return AppException.conflict(ErrorCode.REPLACEMENT_INVALID, message);
  }
}
