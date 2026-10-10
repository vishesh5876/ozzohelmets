import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { HelmetWarranty } from '@prisma/client';
import {
  ActorType,
  type CustomerWarrantyDto,
  ErrorCode,
  type HelmetStatus,
  type RegisterWarrantyRequest,
  type WarrantyStatus,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/http/app.exception';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { uuidv7 } from '../../security/uuid';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedCustomer } from '../customer-auth/customer-auth.types';
import { processProofOfPurchase } from '../file-storage/document-processor';
import {
  FILE_STORAGE_PROVIDER,
  type FileStorageProvider,
  type StoredFile,
} from '../file-storage/file-storage.types';
import { OwnedHelmetLocker } from '../helmets/domain/owned-helmet.locker';
import { PublicEmergencyCacheService } from '../public-emergency-cache/public-emergency-cache.service';
import { MalwareScannerService } from '../file-storage/malware-scanner.service';
import { metrics } from '../../infrastructure/metrics/metrics';
import {
  effectiveStatus,
  isoDate,
  toDate,
  todayUtc,
  WarrantyPolicyService,
} from './domain/warranty-policy';

/** Helmet states in which a current owner may register a warranty. */
const REGISTRABLE: readonly HelmetStatus[] = [
  'ACTIVATED',
  'ACTIVE',
  'LOST',
  'STOLEN',
  'DAMAGED',
  'RECALLED',
];

/**
 * Warranty = coverage of ONE physical helmet. It survives ownership transfers; the registrant's
 * private purchase details (seller, invoice, notes, proof document) are shown only to the
 * registrant while they still own the helmet. All dates are computed here from the model policy.
 */
@Injectable()
export class WarrantyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: WarrantyPolicyService,
    private readonly locker: OwnedHelmetLocker,
    private readonly audit: AuditService,
    private readonly cache: PublicEmergencyCacheService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly storage: FileStorageProvider,
    private readonly scanner: MalwareScannerService,
  ) {}

  async forCustomer(
    customer: AuthenticatedCustomer,
    helmetId: string,
  ): Promise<CustomerWarrantyDto> {
    const helmet = await this.ownedHelmet(customer.id, helmetId);
    const warranty = await this.prisma.helmetWarranty.findUnique({
      where: { helmetId },
      include: {
        replacedBy: { select: { helmet: { select: { helmetCode: true } } } },
        replacementOf: { select: { helmet: { select: { helmetCode: true } } } },
      },
    });
    const status = effectiveStatus(warranty);
    const isRegistrant = warranty?.registeredByUserId === customer.id;
    return {
      ...summary(warranty, status),
      policy: {
        enabled: helmet.helmetModel.warrantyEnabled,
        months: helmet.helmetModel.warrantyMonths,
      },
      canRegister:
        !warranty &&
        helmet.helmetModel.warrantyEnabled &&
        helmet.helmetModel.warrantyMonths > 0 &&
        REGISTRABLE.includes(helmet.status),
      details:
        warranty && isRegistrant
          ? {
              purchaseChannel: warranty.purchaseChannel,
              sellerName: warranty.sellerName,
              sellerCity: warranty.sellerCity,
              invoiceNumber: warranty.invoiceNumber,
              notes: warranty.notes,
              hasProof: warranty.proofKey !== null,
              proofUploadedAt: warranty.proofUploadedAt?.toISOString() ?? null,
            }
          : null,
      replacedByHelmetCode: warranty?.replacedBy?.helmet.helmetCode ?? null,
      replacesHelmetCode: warranty?.replacementOf?.helmet.helmetCode ?? null,
    };
  }

  /**
   * Registers coverage for a helmet the customer owns. Row-locked and backed by a unique index on
   * `helmet_id`: a double submit with the same purchase date returns the existing record;
   * anything else conflicts.
   */
  async register(
    customer: AuthenticatedCustomer,
    helmetId: string,
    dto: RegisterWarrantyRequest,
    meta: RequestMeta,
  ): Promise<CustomerWarrantyDto> {
    const purchaseDate = toDate(dto.purchaseDate);
    let publicToken: string | null = null;
    try {
      publicToken = await this.prisma.$transaction(async (tx) => {
        const { helmet } = await this.locker.lockOwned(tx, helmetId, customer.id);
        const existing = await tx.helmetWarranty.findUnique({ where: { helmetId } });
        if (existing) {
          if (
            existing.registeredByUserId === customer.id &&
            isoDate(existing.purchaseDate) === isoDate(purchaseDate)
          )
            return null; // idempotent repeat
          throw AppException.conflict(
            ErrorCode.WARRANTY_ALREADY_REGISTERED,
            'A warranty is already registered for this helmet.',
          );
        }
        if (!REGISTRABLE.includes(helmet.status)) {
          throw AppException.conflict(
            ErrorCode.WARRANTY_NOT_REGISTRABLE,
            'A warranty cannot be registered for this helmet in its current state.',
            { status: helmet.status },
          );
        }
        const info = await tx.helmet.findUniqueOrThrow({
          where: { id: helmetId },
          select: {
            helmetModel: { select: { warrantyEnabled: true, warrantyMonths: true } },
            batch: { select: { manufacturingDate: true } },
          },
        });
        this.policy.assertPurchaseDate(purchaseDate, info.batch.manufacturingDate);
        const { start, end } = this.policy.coverageFor(info.helmetModel, purchaseDate);
        const id = uuidv7();
        await tx.helmetWarranty.create({
          data: {
            id,
            helmetId,
            registeredByUserId: customer.id,
            status: 'ACTIVE',
            registrationSource: 'CUSTOMER',
            purchaseDate,
            warrantyStartDate: start,
            warrantyEndDate: end,
            purchaseChannel: dto.purchaseChannel ?? null,
            sellerName: dto.sellerName ?? null,
            sellerCity: dto.sellerCity ?? null,
            invoiceNumber: dto.invoiceNumber ?? null,
            notes: dto.notes ?? null,
          },
        });
        await this.history(tx, id, {
          event: 'REGISTERED',
          fromStatus: null,
          toStatus: 'ACTIVE',
          actorType: ActorType.OWNER,
          actorId: customer.id,
          changes: { startDate: isoDate(start), endDate: isoDate(end) },
        });
        // Dates only — never invoice numbers, seller details or notes.
        await this.audit.record(
          {
            action: AuditAction.WARRANTY_REGISTERED,
            entityType: 'helmet',
            entityId: helmetId,
            userId: customer.id,
            ipHash: meta.ipHash,
            metadata: { warrantyId: id, endDate: isoDate(end), source: 'CUSTOMER' },
          },
          tx,
        );
        return helmet.publicToken;
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppException.conflict(
          ErrorCode.WARRANTY_ALREADY_REGISTERED,
          'A warranty is already registered for this helmet.',
        );
      throw err;
    }
    if (publicToken) await this.cache.invalidate(publicToken);
    return this.forCustomer(customer, helmetId);
  }

  async uploadProof(
    customer: AuthenticatedCustomer,
    helmetId: string,
    file: Buffer | undefined,
    meta: RequestMeta,
  ): Promise<CustomerWarrantyDto> {
    if (!file)
      throw new AppException(ErrorCode.INVALID_FILE, 'Choose a file.', HttpStatus.BAD_REQUEST);
    const doc = await processProofOfPurchase(file, this.config.get('WARRANTY_PROOF_MAX_BYTES'));
    // PDFs are stored as uploaded, so they are malware-scanned (if enabled) before any write.
    // Images were fully decoded and re-encoded by the processor.
    if (doc.contentType === 'application/pdf') {
      try {
        await this.scanner.assertClean(doc.data, 'warranty_proof');
      } catch (err) {
        metrics.uploads.inc({ kind: 'warranty_proof', result: 'rejected_scan' });
        throw err;
      }
    }
    const key = `warranty-proofs/${uuidv7()}.${doc.extension}`;
    await this.storage.put(key, doc.data, doc.contentType);
    metrics.uploads.inc({ kind: 'warranty_proof', result: 'stored' });
    let previous: string | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const warranty = await this.registrantWarranty(tx, customer, helmetId);
        previous = warranty.proofKey;
        await tx.helmetWarranty.update({
          where: { id: warranty.id },
          data: { proofKey: key, proofContentType: doc.contentType, proofUploadedAt: new Date() },
        });
        await this.history(tx, warranty.id, {
          event: 'PROOF_UPLOADED',
          fromStatus: warranty.status,
          toStatus: warranty.status,
          actorType: ActorType.OWNER,
          actorId: customer.id,
          changes: { contentType: doc.contentType, replaced: previous !== null },
        });
        await this.audit.record(
          {
            action: AuditAction.WARRANTY_PROOF_UPLOADED,
            entityType: 'helmet',
            entityId: helmetId,
            userId: customer.id,
            ipHash: meta.ipHash,
            metadata: {
              warrantyId: warranty.id,
              contentType: doc.contentType,
              bytes: doc.data.length,
            },
          },
          tx,
        );
      });
    } catch (err) {
      await this.storage.delete(key);
      throw err;
    }
    if (previous) await this.storage.delete(previous);
    return this.forCustomer(customer, helmetId);
  }

  async removeProof(
    customer: AuthenticatedCustomer,
    helmetId: string,
    meta: RequestMeta,
  ): Promise<CustomerWarrantyDto> {
    const key = await this.prisma.$transaction(async (tx) => {
      const warranty = await this.registrantWarranty(tx, customer, helmetId);
      if (!warranty.proofKey) {
        throw AppException.notFound(
          ErrorCode.WARRANTY_PROOF_NOT_FOUND,
          'No proof of purchase uploaded.',
        );
      }
      await tx.helmetWarranty.update({
        where: { id: warranty.id },
        data: { proofKey: null, proofContentType: null, proofUploadedAt: null },
      });
      await this.history(tx, warranty.id, {
        event: 'PROOF_REMOVED',
        fromStatus: warranty.status,
        toStatus: warranty.status,
        actorType: ActorType.OWNER,
        actorId: customer.id,
      });
      await this.audit.record(
        {
          action: AuditAction.WARRANTY_PROOF_REMOVED,
          entityType: 'helmet',
          entityId: helmetId,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { warrantyId: warranty.id },
        },
        tx,
      );
      return warranty.proofKey;
    });
    await this.storage.delete(key);
    return this.forCustomer(customer, helmetId);
  }

  /** The registrant's own document (not available to later owners). */
  async proofForCustomer(customer: AuthenticatedCustomer, helmetId: string): Promise<StoredFile> {
    const warranty = await this.prisma.$transaction((tx) =>
      this.registrantWarranty(tx, customer, helmetId, false),
    );
    const file = warranty.proofKey ? await this.storage.get(warranty.proofKey) : null;
    if (!file)
      throw AppException.notFound(
        ErrorCode.WARRANTY_PROOF_NOT_FOUND,
        'No proof of purchase uploaded.',
      );
    return file;
  }

  /** Coverage facts safe for the public verification page (no purchase details). */
  async publicSummary(
    helmetId: string,
  ): Promise<{ status: WarrantyStatus; endsOn: string | null }> {
    const w = await this.prisma.helmetWarranty.findUnique({
      where: { helmetId },
      select: { status: true, warrantyEndDate: true },
    });
    const status = effectiveStatus(w);
    return {
      status,
      endsOn:
        w && (status === 'ACTIVE' || status === 'EXPIRED') ? isoDate(w.warrantyEndDate) : null,
    };
  }

  /**
   * Replacement policy, called inside ReplacementService's transaction: the original warranty
   * becomes REPLACED and — unless the replacement already has its own — the replacement helmet
   * gets coverage per `WARRANTY_REPLACEMENT_POLICY` (default: original end date). Void coverage
   * is never inherited; invoice/proof are never copied.
   */
  async applyReplacement(
    tx: PrismaTx,
    input: {
      originalHelmetId: string;
      replacementHelmetId: string;
      replacementHelmetCode: string;
      ownerUserId: string;
      adminId: string;
      overrideEndDate?: string;
    },
    meta: RequestMeta,
  ): Promise<void> {
    const original = await tx.helmetWarranty.findUnique({
      where: { helmetId: input.originalHelmetId },
    });
    if (
      !original ||
      original.status === 'VOID' ||
      original.status === 'CANCELLED' ||
      original.status === 'REPLACED'
    )
      return;
    await tx.helmetWarranty.update({ where: { id: original.id }, data: { status: 'REPLACED' } });
    await this.history(tx, original.id, {
      event: 'REPLACED',
      fromStatus: original.status,
      toStatus: 'REPLACED',
      actorType: ActorType.ADMIN,
      actorId: input.adminId,
      reasonCode: 'HELMET_REPLACED',
      changes: { replacementHelmetCode: input.replacementHelmetCode },
    });
    await this.audit.record(
      {
        action: AuditAction.WARRANTY_UPDATED,
        entityType: 'helmet',
        entityId: input.originalHelmetId,
        adminId: input.adminId,
        ipHash: meta.ipHash,
        metadata: { warrantyId: original.id, to: 'REPLACED' },
      },
      tx,
    );

    const already = await tx.helmetWarranty.findUnique({
      where: { helmetId: input.replacementHelmetId },
    });
    if (already) return; // the replacement keeps its own coverage
    const model = await tx.helmet.findUniqueOrThrow({
      where: { id: input.replacementHelmetId },
      select: { helmetModel: { select: { warrantyMonths: true } } },
    });
    const today = todayUtc();
    const override = input.overrideEndDate ? toDate(input.overrideEndDate) : undefined;
    if (override && override < today) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'The replacement warranty end date cannot be in the past.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { start, end } = this.policy.replacement({
      originalEnd: original.warrantyEndDate,
      linkDate: today,
      replacementModelMonths: model.helmetModel.warrantyMonths,
      overrideEnd: override,
    });
    const id = uuidv7();
    await tx.helmetWarranty.create({
      data: {
        id,
        helmetId: input.replacementHelmetId,
        registeredByUserId: input.ownerUserId,
        status: 'ACTIVE',
        registrationSource: 'REPLACEMENT',
        purchaseDate: original.purchaseDate < start ? original.purchaseDate : start,
        warrantyStartDate: start,
        warrantyEndDate: end,
        replacementOfWarrantyId: original.id,
      },
    });
    await this.history(tx, id, {
      event: 'ISSUED_FOR_REPLACEMENT',
      fromStatus: null,
      toStatus: 'ACTIVE',
      actorType: ActorType.ADMIN,
      actorId: input.adminId,
      reasonCode: override ? 'ADMIN_OVERRIDE' : this.config.get('WARRANTY_REPLACEMENT_POLICY'),
      changes: { startDate: isoDate(start), endDate: isoDate(end) },
    });
    await this.audit.record(
      {
        action: AuditAction.WARRANTY_REGISTERED,
        entityType: 'helmet',
        entityId: input.replacementHelmetId,
        adminId: input.adminId,
        ipHash: meta.ipHash,
        metadata: { warrantyId: id, endDate: isoDate(end), source: 'REPLACEMENT' },
      },
      tx,
    );
  }

  async history(
    tx: PrismaTx,
    warrantyId: string,
    e: {
      event: HelmetWarrantyHistoryEvent;
      fromStatus: HelmetWarranty['status'] | null;
      toStatus: HelmetWarranty['status'];
      actorType: ActorType;
      actorId: string | null;
      reasonCode?: string | null;
      note?: string | null;
      changes?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.warrantyHistory.create({
      data: {
        warrantyId,
        event: e.event,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorType: e.actorType,
        actorId: e.actorId,
        reasonCode: e.reasonCode ?? null,
        note: e.note ?? null,
        changes: (e.changes ?? undefined) as object | undefined,
      },
    });
  }

  private async ownedHelmet(userId: string, helmetId: string) {
    const ownership = await this.prisma.helmetOwnership.findFirst({
      where: { userId, helmetId, status: 'ACTIVE' },
      select: {
        helmet: {
          select: {
            status: true,
            helmetModel: { select: { warrantyEnabled: true, warrantyMonths: true } },
          },
        },
      },
    });
    if (!ownership) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    return ownership.helmet;
  }

  /** Current owner AND original registrant; otherwise the warranty looks absent (404). */
  private async registrantWarranty(
    tx: PrismaTx,
    customer: AuthenticatedCustomer,
    helmetId: string,
    lock = true,
  ): Promise<HelmetWarranty> {
    if (lock) await this.locker.lockOwned(tx, helmetId, customer.id);
    else {
      const owned = await tx.helmetOwnership.count({
        where: { helmetId, userId: customer.id, status: 'ACTIVE' },
      });
      if (!owned) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    }
    const warranty = await tx.helmetWarranty.findUnique({ where: { helmetId } });
    if (!warranty || warranty.registeredByUserId !== customer.id) {
      throw AppException.notFound(
        ErrorCode.WARRANTY_NOT_FOUND,
        'No warranty registered by you for this helmet.',
      );
    }
    return warranty;
  }
}

type HelmetWarrantyHistoryEvent =
  | 'REGISTERED'
  | 'DATE_CORRECTED'
  | 'ADMIN_UPDATED'
  | 'VOIDED'
  | 'RESTORED'
  | 'REPLACED'
  | 'ISSUED_FOR_REPLACEMENT'
  | 'PROOF_UPLOADED'
  | 'PROOF_REMOVED';

export function summary(
  w: Pick<
    HelmetWarranty,
    'registrationSource' | 'registeredAt' | 'purchaseDate' | 'warrantyStartDate' | 'warrantyEndDate'
  > | null,
  status: WarrantyStatus,
) {
  return {
    status,
    source: w?.registrationSource ?? null,
    registeredAt: w?.registeredAt.toISOString() ?? null,
    purchaseDate: w ? isoDate(w.purchaseDate) : null,
    startDate: w ? isoDate(w.warrantyStartDate) : null,
    endDate: w ? isoDate(w.warrantyEndDate) : null,
  };
}
