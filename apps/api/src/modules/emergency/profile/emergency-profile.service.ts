import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  type EmergencyProfileDto,
  type EmergencyReadinessDto,
  ErrorCode,
  OPERATIONAL_STATUSES,
  type PublicEmergencyDto,
  SAFETY_ID_IN_USE,
} from '@helmet/types';
import { AppConfigService } from '../../../config/app-config.service';
import { AppException } from '../../../common/http/app.exception';
import type { RequestMeta } from '../../../common/utils/request-context';
import { PrismaService, type PrismaTx } from '../../../infrastructure/prisma/prisma.service';
import { uuidv7 } from '../../../security/uuid';
import type { AuthenticatedCustomer } from '../../customer-auth/customer-auth.types';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit-actions';
import { EmergencyReadinessService } from '../../emergency-readiness/emergency-readiness.service';
import { missingRequirements } from '../../emergency-readiness/readiness';
import {
  FILE_STORAGE_PROVIDER,
  type FileStorageProvider,
  type StoredFile,
} from '../../file-storage/file-storage.types';
import { processProfilePhoto } from '../../file-storage/image-processor';
import { HelmetStatusService } from '../../helmets/domain/helmet-status.service';
import { SafetyIdCoreService } from '../../safety-ids/domain/safety-id-core.service';
import { PublicEmergencyCacheService } from '../../public-emergency-cache/public-emergency-cache.service';
import { type DecryptedProfile, decryptProfile } from '../domain/decrypted-profile';
import { ProfileCipher } from '../domain/profile-cipher';
import { buildPublicProfile } from '../domain/public-profile';
import { EmergencyContactsService } from '../contacts/emergency-contacts.service';
import { EmergencyVisibilityService } from '../visibility/emergency-visibility.service';
import { PROFILE_CIPHER } from '../emergency.tokens';
import { metrics } from '../../../infrastructure/metrics/metrics';
import type { UpdateEmergencyProfileDto } from './emergency-profile.dto';

const MEDICAL_LIST_FIELDS = ['allergies', 'medicalConditions', 'medications'] as const;

/** Plain column values, valid for both create and update. */
type ProfileColumns = Omit<Prisma.EmergencyProfileUncheckedCreateInput, 'id' | 'userId'>;

@Injectable()
export class EmergencyProfileService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROFILE_CIPHER) private readonly cipher: ProfileCipher,
    private readonly readiness: EmergencyReadinessService,
    private readonly statuses: HelmetStatusService,
    private readonly core: SafetyIdCoreService,
    private readonly audit: AuditService,
    private readonly publicCache: PublicEmergencyCacheService,
    private readonly contacts: EmergencyContactsService,
    private readonly visibility: EmergencyVisibilityService,
    private readonly config: AppConfigService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly storage: FileStorageProvider,
  ) {}

  async get(userId: string): Promise<EmergencyProfileDto> {
    const profile = await this.loadDecrypted(userId);
    return toDto(profile);
  }

  /** Decrypted default profile (helmet_id IS NULL) or null. Caller must not cache/log the result. */
  async loadDecrypted(userId: string, tx?: PrismaTx): Promise<DecryptedProfile | null> {
    const row = await (tx ?? this.prisma).emergencyProfile.findFirst({
      where: { userId, helmetId: null },
    });
    return row ? decryptProfile(row, this.cipher) : null;
  }

  async update(
    customer: AuthenticatedCustomer,
    dto: UpdateEmergencyProfileDto,
    meta: RequestMeta,
  ): Promise<EmergencyProfileDto> {
    this.validateDateOfBirth(dto.dateOfBirth);
    const changedFields = Object.keys(dto).filter(
      (k) => (dto as Record<string, unknown>)[k] !== undefined,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, customer.id);
      const existing = await tx.emergencyProfile.findFirst({
        where: { userId: customer.id, helmetId: null },
        select: { id: true, emergencyProfileEnabled: true },
      });
      if (existing?.emergencyProfileEnabled && dto.name === null) {
        // Checked before writing: the DB CHECK constraint is only a backstop.
        throw new AppException(
          ErrorCode.PROFILE_REQUIREMENT,
          'Your emergency profile is enabled and needs a name. Disable the profile first to remove it.',
          HttpStatus.CONFLICT,
          { missing: ['NAME'] },
        );
      }
      const id = existing?.id ?? uuidv7();
      const data = this.toColumns(id, dto);
      if (existing) await tx.emergencyProfile.update({ where: { id }, data });
      else await tx.emergencyProfile.create({ data: { id, userId: customer.id, ...data } });
      await this.readiness.assertStillValidIfEnabled(customer.id, tx);
      // Only field NAMES are audited — never the (medical) values.
      await this.audit.record(
        {
          action: AuditAction.EMERGENCY_PROFILE_UPDATED,
          entityType: 'emergency_profile',
          entityId: id,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { changedFields },
        },
        tx,
      );
      return this.loadDecrypted(customer.id, tx);
    });
    await this.publicCache.invalidateForOwner(customer.id);
    return toDto(updated);
  }

  async readinessFor(userId: string): Promise<EmergencyReadinessDto> {
    return this.readiness.readiness(userId);
  }

  /**
   * Enables the account emergency profile (fails with PROFILE_INCOMPLETE listing what is missing)
   * and switches sharing on for the chosen Safety IDs (helmet ids select their linked Safety ID).
   * With no targets it switches on the Safety ID only when the customer has exactly one in use —
   * with several, each must be chosen explicitly so medical data is never exposed by accident.
   */
  async enable(
    customer: AuthenticatedCustomer,
    meta: RequestMeta,
    targets: { safetyIds?: string[]; helmetIds?: string[] } = {},
  ): Promise<EmergencyReadinessDto> {
    const tokens = await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, customer.id);
      await this.readiness.assertCanEnable(customer.id, tx);
      const profile = await this.enableProfileRow(tx, customer.id);
      const explicit = targets.safetyIds !== undefined || targets.helmetIds !== undefined;
      const ids = new Set(targets.safetyIds ?? []);
      for (const helmetId of new Set(targets.helmetIds ?? []))
        ids.add(await this.safetyIdForOwnedHelmet(tx, customer.id, helmetId));
      if (!explicit) {
        const inUse = await this.safetyIdsInUse(tx, customer.id);
        if (inUse.length === 1) ids.add(inUse[0]!);
      }
      const changed: string[] = [];
      for (const safetyId of ids) changed.push(await this.core.switchOn(tx, safetyId, customer.id));
      await this.audit.record(
        {
          action: AuditAction.EMERGENCY_PROFILE_ENABLED,
          entityType: 'emergency_profile',
          entityId: profile.id,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { safetyIdsEnabled: ids.size },
        },
        tx,
      );
      return changed;
    });
    await this.publicCache.invalidate(...tokens);
    await this.publicCache.invalidateForOwner(customer.id);
    return this.readiness.readiness(customer.id);
  }

  /**
   * Disables the account profile: public pages stop showing it immediately, every Safety ID (and
   * linked helmet) switch turns off and ACTIVE ones return to ACTIVATED.
   */
  async disable(
    customer: AuthenticatedCustomer,
    meta: RequestMeta,
  ): Promise<EmergencyReadinessDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, customer.id);
      const profile = await tx.emergencyProfile.findFirst({
        where: { userId: customer.id, helmetId: null },
        select: { id: true },
      });
      if (!profile)
        throw AppException.notFound(ErrorCode.NOT_FOUND, 'No emergency profile to disable.');
      await tx.emergencyProfile.update({
        where: { id: profile.id },
        data: { emergencyProfileEnabled: false, enabledAt: null },
      });
      const helmets = await this.switchOffEverything(
        tx,
        customer.id,
        { type: ActorType.OWNER, id: customer.id },
        'Emergency profile disabled',
      );
      await this.audit.record(
        {
          action: AuditAction.EMERGENCY_PROFILE_DISABLED,
          entityType: 'emergency_profile',
          entityId: profile.id,
          userId: customer.id,
          ipHash: meta.ipHash,
          metadata: { helmetsDeactivated: helmets },
        },
        tx,
      );
    });
    await this.publicCache.invalidateForOwner(customer.id);
    return this.readiness.readiness(customer.id);
  }

  /**
   * Turns all public emergency sharing off for an account inside the caller's transaction (used
   * when an account is marked deleted). The caller must invalidate the public cache after commit
   * (`PublicEmergencyCacheService.invalidateForOwner`).
   */
  async switchOffAllSharing(
    tx: PrismaTx,
    userId: string,
    actor: { type: ActorType; id: string | null },
    reason: string,
  ): Promise<number> {
    await tx.emergencyProfile.updateMany({
      where: { userId, helmetId: null },
      data: { emergencyProfileEnabled: false, enabledAt: null },
    });
    return this.switchOffEverything(tx, userId, actor, reason);
  }

  /** Helmet switches + statuses first (lock order: helmets → Safety IDs), then Safety IDs. */
  private async switchOffEverything(
    tx: PrismaTx,
    userId: string,
    actor: { type: ActorType; id: string | null },
    reason: string,
  ): Promise<number> {
    await tx.helmetEmergencySetting.updateMany({
      where: { userId, enabled: true },
      data: { enabled: false },
    });
    const helmets = await this.ownedHelmetsInStatus(tx, userId, 'ACTIVE');
    for (const helmetId of helmets) {
      await this.statuses.apply(tx, {
        helmetId,
        from: 'ACTIVE',
        to: 'ACTIVATED',
        actor,
        reason,
        reasonCode: 'EMERGENCY_DISABLED',
      });
    }
    await this.core.switchOffAllForUser(tx, userId);
    return helmets.length;
  }

  /** Switches emergency sharing on for ONE owned Safety ID (explicit, per-Safety-ID consent). */
  async enableForSafetyId(
    customer: AuthenticatedCustomer,
    safetyId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const token = await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, customer.id);
      await this.readiness.assertCanEnable(customer.id, tx);
      await this.enableProfileRow(tx, customer.id);
      const publicToken = await this.core.switchOn(tx, safetyId, customer.id);
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_SHARING_ENABLED,
          entityType: 'safety_id',
          entityId: safetyId,
          userId: customer.id,
          ipHash: meta.ipHash,
        },
        tx,
      );
      return publicToken;
    });
    await this.publicCache.invalidate(token);
  }

  /** Stops exposing emergency information on ONE Safety ID; the account profile stays as it is. */
  async disableForSafetyId(
    customer: AuthenticatedCustomer,
    safetyId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const token = await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, customer.id);
      const publicToken = await this.core.switchOff(tx, safetyId, customer.id);
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_SHARING_DISABLED,
          entityType: 'safety_id',
          entityId: safetyId,
          userId: customer.id,
          ipHash: meta.ipHash,
        },
        tx,
      );
      return publicToken;
    });
    await this.publicCache.invalidate(token);
  }

  /** Compatibility (Phase 8 helmet endpoints): acts on the helmet's linked Safety ID. */
  async enableForHelmet(
    customer: AuthenticatedCustomer,
    helmetId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const safetyId = await this.safetyIdForOwnedHelmet(this.prisma, customer.id, helmetId);
    await this.enableForSafetyId(customer, safetyId, meta);
  }

  async disableForHelmet(
    customer: AuthenticatedCustomer,
    helmetId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const safetyId = await this.safetyIdForOwnedHelmet(this.prisma, customer.id, helmetId);
    await this.disableForSafetyId(customer, safetyId, meta);
  }

  private async enableProfileRow(tx: PrismaTx, userId: string): Promise<{ id: string }> {
    const profile = await tx.emergencyProfile.findFirstOrThrow({
      where: { userId, helmetId: null },
      select: { id: true, emergencyProfileEnabled: true },
    });
    if (!profile.emergencyProfileEnabled) {
      await tx.emergencyProfile.update({
        where: { id: profile.id },
        data: { emergencyProfileEnabled: true, enabledAt: new Date() },
      });
    }
    return profile;
  }

  /** Owned Safety IDs that may share now (in use; a linked helmet is in normal use). */
  private async safetyIdsInUse(tx: PrismaTx, userId: string): Promise<string[]> {
    const rows = await tx.safetyIdOwnership.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        safetyIdRef: { status: { in: [...SAFETY_ID_IN_USE] } },
      },
      select: {
        safetyId: true,
        safetyIdRef: {
          select: {
            helmetLinks: {
              where: { endedAt: null },
              select: { helmet: { select: { status: true } } },
            },
          },
        },
      },
    });
    return rows
      .filter((r) => {
        const helmet = r.safetyIdRef.helmetLinks[0]?.helmet;
        return !helmet || OPERATIONAL_STATUSES.includes(helmet.status);
      })
      .map((r) => r.safetyId);
  }

  /** The Safety ID linked to a helmet the customer owns (404 otherwise; 409 when it has none). */
  private async safetyIdForOwnedHelmet(
    db: PrismaTx,
    userId: string,
    helmetId: string,
  ): Promise<string> {
    const owned = await db.helmetOwnership.findFirst({
      where: { helmetId, userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!owned) throw AppException.notFound(ErrorCode.HELMET_NOT_FOUND, 'Helmet not found.');
    const linked = await this.core.linkedSafetyId(db, helmetId);
    if (!linked)
      throw new AppException(
        ErrorCode.SAFETY_ID_ACTION_NOT_ALLOWED,
        'This helmet has no Safety ID, so there is no QR to share emergency information on.',
        HttpStatus.CONFLICT,
      );
    return linked.id;
  }

  /** What an anonymous scan would show if the profile were enabled — for the review step. */
  async preview(customerId: string): Promise<Pick<PublicEmergencyDto, 'profile' | 'contacts'>> {
    const profile = await this.loadDecrypted(customerId);
    if (!profile) return { profile: {}, contacts: undefined };
    const [visibility, contacts] = await Promise.all([
      this.visibility.flags(customerId),
      this.contacts.activeContacts(customerId),
    ]);
    return buildPublicProfile(profile, visibility, contacts, {
      photoUrl: '/api/v1/customer/emergency-profile/photo',
    });
  }

  /**
   * Public view for an owner on one Safety ID, used by the QR endpoint. Returns null unless the
   * Safety ID's switch is on and the profile exists, is enabled and meets the minimum requirements.
   */
  async publicView(
    userId: string,
    safetyId: string,
    photoUrl: string,
  ): Promise<{
    data: Pick<PublicEmergencyDto, 'profile' | 'contacts'>;
    photo: { key: string; contentType: string } | null;
  } | null> {
    // Per-Safety-ID consent first: a Safety ID whose switch is off never decrypts anything.
    if (!(await this.readiness.safetyIdEnabled(safetyId, userId))) return null;
    const profile = await this.loadDecrypted(userId);
    if (!profile?.enabled) return null;
    const facts = await this.readiness.facts(userId);
    if (missingRequirements(facts).length > 0) return null;
    const [visibility, contacts] = await Promise.all([
      this.visibility.flags(userId),
      this.contacts.activeContacts(userId),
    ]);
    const data = buildPublicProfile(profile, visibility, contacts, { photoUrl });
    const photo =
      data.profile.photoUrl && profile.photoKey && profile.photoContentType
        ? { key: profile.photoKey, contentType: profile.photoContentType }
        : null;
    return { data, photo };
  }

  async setPhoto(
    customer: AuthenticatedCustomer,
    file: Buffer | undefined,
    meta: RequestMeta,
  ): Promise<EmergencyProfileDto> {
    if (!file)
      throw new AppException(
        ErrorCode.INVALID_FILE,
        'Attach an image file named "photo".',
        HttpStatus.BAD_REQUEST,
      );
    const image = await processProfilePhoto(file, this.config.get('PROFILE_PHOTO_MAX_BYTES'));
    const key = `profile-photos/${uuidv7()}.webp`;
    await this.storage.put(key, image.data, image.contentType);
    metrics.uploads.inc({ kind: 'profile_photo', result: 'stored' });

    let previousKey: string | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.emergencyProfile.findFirst({
          where: { userId: customer.id, helmetId: null },
          select: { id: true, photoKey: true },
        });
        previousKey = existing?.photoKey ?? null;
        const data = {
          photoKey: key,
          photoContentType: image.contentType,
          photoUpdatedAt: new Date(),
        };
        const id = existing?.id ?? uuidv7();
        if (existing) await tx.emergencyProfile.update({ where: { id }, data });
        else await tx.emergencyProfile.create({ data: { id, userId: customer.id, ...data } });
        await this.audit.record(
          {
            action: AuditAction.EMERGENCY_PROFILE_PHOTO_UPDATED,
            entityType: 'emergency_profile',
            entityId: id,
            userId: customer.id,
            ipHash: meta.ipHash,
            metadata: { action: 'set' },
          },
          tx,
        );
      });
    } catch (err) {
      await this.storage.delete(key);
      throw err;
    }
    if (previousKey) await this.storage.delete(previousKey);
    await this.publicCache.invalidateForOwner(customer.id);
    return this.get(customer.id);
  }

  async deletePhoto(
    customer: AuthenticatedCustomer,
    meta: RequestMeta,
  ): Promise<EmergencyProfileDto> {
    const existing = await this.prisma.emergencyProfile.findFirst({
      where: { userId: customer.id, helmetId: null },
      select: { id: true, photoKey: true },
    });
    if (existing?.photoKey) {
      await this.prisma.emergencyProfile.update({
        where: { id: existing.id },
        data: { photoKey: null, photoContentType: null, photoUpdatedAt: new Date() },
      });
      await this.storage.delete(existing.photoKey);
      await this.audit.record({
        action: AuditAction.EMERGENCY_PROFILE_PHOTO_UPDATED,
        entityType: 'emergency_profile',
        entityId: existing.id,
        userId: customer.id,
        ipHash: meta.ipHash,
        metadata: { action: 'delete' },
      });
      await this.publicCache.invalidateForOwner(customer.id);
    }
    return this.get(customer.id);
  }

  async photo(userId: string): Promise<StoredFile | null> {
    const row = await this.prisma.emergencyProfile.findFirst({
      where: { userId, helmetId: null },
      select: { photoKey: true },
    });
    return row?.photoKey ? this.storage.get(row.photoKey) : null;
  }

  private toColumns(id: string, dto: UpdateEmergencyProfileDto): ProfileColumns {
    const data: ProfileColumns = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.bloodGroup !== undefined) data.bloodGroup = dto.bloodGroup;
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.organDonor !== undefined) data.organDonor = dto.organDonor;
    if (dto.dateOfBirth !== undefined)
      data.dateOfBirthCiphertext = this.cipher.encryptText(
        id,
        'dateOfBirth',
        dto.dateOfBirth?.slice(0, 10),
      );
    if (dto.emergencyNotes !== undefined)
      data.emergencyNotesCiphertext = this.cipher.encryptText(
        id,
        'emergencyNotes',
        dto.emergencyNotes,
      );
    for (const field of MEDICAL_LIST_FIELDS) {
      const value = dto[field];
      if (value !== undefined)
        data[`${field}Ciphertext`] = this.cipher.encryptList(id, field, dedupe(value));
    }
    return data;
  }

  private validateDateOfBirth(value: string | null | undefined): void {
    if (!value) return;
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.getTime() > Date.now() ||
      date.getUTCFullYear() < 1900
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Enter a valid date of birth.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async ownedHelmetsInStatus(
    tx: PrismaTx,
    userId: string,
    status: 'ACTIVATED' | 'ACTIVE',
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT h.id FROM helmets h
      JOIN helmet_ownerships o ON o.helmet_id = h.id AND o.status = 'ACTIVE'::"OwnershipStatus"
      WHERE o.user_id = ${userId}::uuid AND h.status = ${status}::"HelmetStatus"
      FOR UPDATE OF h`;
    return rows.map((r) => r.id);
  }

  /** Serialises enable/disable/edit transactions for one customer. */
  private async lockUser(tx: PrismaTx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toDto(p: DecryptedProfile | null): EmergencyProfileDto {
  return {
    name: p?.name ?? null,
    hasPhoto: p?.hasPhoto ?? false,
    bloodGroup: p?.bloodGroup ?? null,
    dateOfBirth: p?.dateOfBirth ?? null,
    gender: p?.gender ?? null,
    allergies: p?.allergies ?? [],
    medicalConditions: p?.medicalConditions ?? [],
    medications: p?.medications ?? [],
    emergencyNotes: p?.emergencyNotes ?? null,
    organDonor: p?.organDonor ?? null,
    emergencyProfileEnabled: p?.enabled ?? false,
    updatedAt: p?.updatedAt.toISOString() ?? null,
  };
}
