import { HttpStatus, Injectable } from '@nestjs/common';
import type { EmergencyContact } from '@prisma/client';
import { type EmergencyContactDto, ErrorCode, MAX_EMERGENCY_CONTACTS } from '@helmet/types';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/http/app.exception';
import { normalizePhone } from '../../../common/utils/phone';
import type { RequestMeta } from '../../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../../infrastructure/prisma/prisma.service';
import type { AuthenticatedCustomer } from '../../customer-auth/customer-auth.types';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit-actions';
import { EmergencyReadinessService } from '../../emergency-readiness/emergency-readiness.service';
import { PublicEmergencyCacheService } from '../../public-emergency-cache/public-emergency-cache.service';
import type { PublicContactSource } from '../domain/public-profile';
import type {
  CreateEmergencyContactDto,
  ReorderEmergencyContactsDto,
  UpdateEmergencyContactDto,
} from './emergency-contacts.dto';

/** Priorities are temporarily shifted by this offset during reorder to dodge the unique index. */
const REORDER_OFFSET = 50;

/**
 * Emergency contacts (max 5 active, priority 1 = called first). Every query is scoped by the
 * authenticated customer id; another customer's contact id behaves exactly like a missing one.
 */
@Injectable()
export class EmergencyContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: EmergencyReadinessService,
    private readonly audit: AuditService,
    private readonly publicCache: PublicEmergencyCacheService,
    private readonly config: AppConfigService,
  ) {}

  async list(userId: string): Promise<EmergencyContactDto[]> {
    const rows = await this.prisma.emergencyContact.findMany({
      where: { userId, isActive: true },
      orderBy: { priority: 'asc' },
    });
    return rows.map(toDto);
  }

  async activeContacts(userId: string, tx?: PrismaTx): Promise<PublicContactSource[]> {
    return (tx ?? this.prisma).emergencyContact.findMany({
      where: { userId, isActive: true },
      orderBy: { priority: 'asc' },
      select: { name: true, relationship: true, phone: true, alternatePhone: true },
    });
  }

  async create(
    customer: AuthenticatedCustomer,
    dto: CreateEmergencyContactDto,
    meta: RequestMeta,
  ): Promise<EmergencyContactDto> {
    const phone = this.phone(dto.phone);
    const alternatePhone = dto.alternatePhone ? this.phone(dto.alternatePhone) : null;
    const created = await this.mutate(customer, meta, 'create', async (tx) => {
      const active = await tx.emergencyContact.findMany({
        where: { userId: customer.id, isActive: true },
        select: { priority: true },
      });
      if (active.length >= MAX_EMERGENCY_CONTACTS) {
        throw new AppException(
          ErrorCode.CONTACT_LIMIT_REACHED,
          `You can add up to ${MAX_EMERGENCY_CONTACTS} emergency contacts.`,
          HttpStatus.CONFLICT,
        );
      }
      const priority = active.reduce((max, c) => Math.max(max, c.priority), 0) + 1;
      return tx.emergencyContact.create({
        data: {
          userId: customer.id,
          name: dto.name,
          relationship: dto.relationship,
          phone,
          alternatePhone,
          priority,
        },
      });
    });
    return toDto(created);
  }

  async update(
    customer: AuthenticatedCustomer,
    id: string,
    dto: UpdateEmergencyContactDto,
    meta: RequestMeta,
  ): Promise<EmergencyContactDto> {
    const phone = dto.phone !== undefined ? this.phone(dto.phone) : undefined;
    const alternatePhone =
      dto.alternatePhone === undefined
        ? undefined
        : dto.alternatePhone
          ? this.phone(dto.alternatePhone)
          : null;
    const updated = await this.mutate(customer, meta, 'update', async (tx) => {
      await this.findOwned(tx, customer.id, id);
      return tx.emergencyContact.update({
        where: { id },
        data: { name: dto.name, relationship: dto.relationship, phone, alternatePhone },
      });
    });
    return toDto(updated);
  }

  /** Deactivates (soft-deletes) a contact and closes the priority gap. */
  async remove(customer: AuthenticatedCustomer, id: string, meta: RequestMeta): Promise<void> {
    await this.mutate(customer, meta, 'delete', async (tx) => {
      const contact = await this.findOwned(tx, customer.id, id);
      await tx.emergencyContact.update({ where: { id }, data: { isActive: false, priority: 100 } });
      const after = await tx.emergencyContact.findMany({
        where: { userId: customer.id, isActive: true, priority: { gt: contact.priority } },
        orderBy: { priority: 'asc' },
      });
      for (const c of after)
        await tx.emergencyContact.update({
          where: { id: c.id },
          data: { priority: c.priority - 1 },
        });
      await this.readiness.assertStillValidIfEnabled(customer.id, tx);
    });
  }

  async reorder(
    customer: AuthenticatedCustomer,
    dto: ReorderEmergencyContactsDto,
    meta: RequestMeta,
  ): Promise<EmergencyContactDto[]> {
    await this.mutate(customer, meta, 'reorder', async (tx) => {
      const active = await tx.emergencyContact.findMany({
        where: { userId: customer.id, isActive: true },
        select: { id: true, priority: true },
      });
      const activeIds = new Set(active.map((c) => c.id));
      if (
        dto.ids.length !== active.length ||
        new Set(dto.ids).size !== dto.ids.length ||
        !dto.ids.every((id) => activeIds.has(id))
      ) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Provide every active contact exactly once.',
          HttpStatus.BAD_REQUEST,
        );
      }
      for (const c of active)
        await tx.emergencyContact.update({
          where: { id: c.id },
          data: { priority: c.priority + REORDER_OFFSET },
        });
      for (const [index, id] of dto.ids.entries())
        await tx.emergencyContact.update({ where: { id }, data: { priority: index + 1 } });
    });
    return this.list(customer.id);
  }

  /** Runs a contact mutation serialised per customer, audits it (no PII) and refreshes public caches. */
  private async mutate<T>(
    customer: AuthenticatedCustomer,
    meta: RequestMeta,
    action: string,
    fn: (tx: PrismaTx) => Promise<T>,
  ): Promise<T> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${customer.id}::uuid FOR UPDATE`;
      const value = await fn(tx);
      const count = await tx.emergencyContact.count({
        where: { userId: customer.id, isActive: true },
      });
      await this.audit.record(
        {
          action: AuditAction.EMERGENCY_CONTACTS_CHANGED,
          entityType: 'emergency_contact',
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { action, activeContacts: count },
        },
        tx,
      );
      return value;
    });
    await this.publicCache.invalidateForOwner(customer.id);
    return result;
  }

  private async findOwned(tx: PrismaTx, userId: string, id: string): Promise<EmergencyContact> {
    const contact = await tx.emergencyContact.findFirst({ where: { id, userId, isActive: true } });
    if (!contact)
      throw AppException.notFound(ErrorCode.CONTACT_NOT_FOUND, 'Emergency contact not found.');
    return contact;
  }

  private phone(raw: string): string {
    const normalized = normalizePhone(raw, this.config.get('DEFAULT_PHONE_REGION'));
    if (!normalized)
      throw new AppException(
        ErrorCode.INVALID_PHONE_NUMBER,
        'Enter a valid phone number for the contact.',
        HttpStatus.BAD_REQUEST,
      );
    return normalized;
  }
}

function toDto(c: EmergencyContact): EmergencyContactDto {
  return {
    id: c.id,
    name: c.name,
    relationship: c.relationship,
    phone: c.phone,
    alternatePhone: c.alternatePhone,
    priority: c.priority,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
