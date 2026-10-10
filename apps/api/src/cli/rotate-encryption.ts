import type { INestApplicationContext } from '@nestjs/common';
import {
  ProfileCipher,
  type EncryptedProfileField,
} from '../modules/emergency/domain/profile-cipher';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { AuditAction } from '../modules/audit/audit-actions';
import { EncryptionService } from '../security/encryption.service';

const PROFILE_FIELDS: { field: EncryptedProfileField; column: string; prop: ProfileColumn }[] = [
  { field: 'dateOfBirth', column: 'date_of_birth_ciphertext', prop: 'dateOfBirthCiphertext' },
  { field: 'allergies', column: 'allergies_ciphertext', prop: 'allergiesCiphertext' },
  {
    field: 'medicalConditions',
    column: 'medical_conditions_ciphertext',
    prop: 'medicalConditionsCiphertext',
  },
  { field: 'medications', column: 'medications_ciphertext', prop: 'medicationsCiphertext' },
  {
    field: 'emergencyNotes',
    column: 'emergency_notes_ciphertext',
    prop: 'emergencyNotesCiphertext',
  },
];
type ProfileColumn =
  | 'dateOfBirthCiphertext'
  | 'allergiesCiphertext'
  | 'medicalConditionsCiphertext'
  | 'medicationsCiphertext'
  | 'emergencyNotesCiphertext';

const versionOf = (ciphertext: string | null) => (ciphertext ? ciphertext.split('.', 1)[0]! : null);

export interface KeyVersionReport {
  keyring: 'data' | 'escrow';
  activeVersion: string;
  /** "<column>": { "<version>": count } */
  versions: Record<string, Record<string, number>>;
}

/** Counts ciphertexts per key version (to know when an old key may be retired). */
export async function encryptionStatus(app: INestApplicationContext): Promise<KeyVersionReport[]> {
  const prisma = app.get(PrismaService);
  const enc = app.get(EncryptionService);
  const data: Record<string, Record<string, number>> = {};
  for (const f of PROFILE_FIELDS) {
    const rows = await prisma.$queryRawUnsafe<{ v: string; n: bigint }[]>(
      `SELECT split_part(${f.column}, '.', 1) AS v, count(*) AS n FROM emergency_profiles
       WHERE ${f.column} IS NOT NULL GROUP BY 1`,
    );
    data[f.column] = Object.fromEntries(rows.map((r) => [r.v, Number(r.n)]));
  }
  const escrowRows = await prisma.$queryRaw<{ v: string; n: bigint }[]>`
    SELECT split_part(pin_ciphertext, '.', 1) AS v, count(*) AS n FROM helmet_activation_secrets GROUP BY 1`;
  return [
    { keyring: 'data', activeVersion: enc.data.activeVersion, versions: data },
    {
      keyring: 'escrow',
      activeVersion: enc.pinEscrow.activeVersion,
      versions: { pin_ciphertext: Object.fromEntries(escrowRows.map((r) => [r.v, Number(r.n)])) },
    },
  ];
}

export interface RotationResult {
  keyring: 'data' | 'escrow';
  activeVersion: string;
  scanned: number;
  reEncrypted: number;
  skippedConcurrentChange: number;
  dryRun: boolean;
}

/**
 * Re-encrypts ciphertexts that are not under the ACTIVE key version (the first keyring entry).
 * Batched with keyset pagination, idempotent (rows already on the active version are not
 * selected) and restartable at any point. Each row is updated only if its ciphertexts are still
 * the ones read (a concurrent owner edit wins and is simply skipped). Plaintext stays in memory
 * for the duration of one row and is never logged. One audit entry with counts per run.
 * Old keys must stay in the keyring until `encryption:status` shows no ciphertexts use them.
 */
export async function rotateEncryption(
  app: INestApplicationContext,
  opts: { keyring: 'data' | 'escrow'; batchSize: number; dryRun: boolean },
): Promise<RotationResult> {
  const prisma = app.get(PrismaService);
  const enc = app.get(EncryptionService);
  const cipher = opts.keyring === 'data' ? enc.data : enc.pinEscrow;
  const active = cipher.activeVersion;
  const prefix = `${active}.`;
  const result: RotationResult = {
    keyring: opts.keyring,
    activeVersion: active,
    scanned: 0,
    reEncrypted: 0,
    skippedConcurrentChange: 0,
    dryRun: opts.dryRun,
  };
  let after = '00000000-0000-0000-0000-000000000000';

  if (opts.keyring === 'data') {
    const profile = new ProfileCipher(cipher);
    for (;;) {
      const rows = await prisma.emergencyProfile.findMany({
        where: {
          id: { gt: after },
          OR: PROFILE_FIELDS.map((f) => ({
            AND: [{ [f.prop]: { not: null } }, { NOT: { [f.prop]: { startsWith: prefix } } }],
          })),
        },
        select: {
          id: true,
          dateOfBirthCiphertext: true,
          allergiesCiphertext: true,
          medicalConditionsCiphertext: true,
          medicationsCiphertext: true,
          emergencyNotesCiphertext: true,
        },
        orderBy: { id: 'asc' },
        take: opts.batchSize,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        result.scanned++;
        const update: Partial<Record<ProfileColumn, string>> = {};
        for (const f of PROFILE_FIELDS) {
          const current = row[f.prop];
          if (!current || versionOf(current) === active) continue;
          // decrypt+encrypt with the same AAD (profile id + field); text and lists alike.
          const plain = profile.decryptText(row.id, f.field, current);
          update[f.prop] = profile.encryptText(row.id, f.field, plain) ?? undefined;
        }
        if (!opts.dryRun && Object.keys(update).length > 0) {
          const { count } = await prisma.emergencyProfile.updateMany({
            where: {
              id: row.id,
              ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f.prop, row[f.prop]])),
            },
            data: update,
          });
          if (count === 1) result.reEncrypted++;
          else result.skippedConcurrentChange++;
        } else if (Object.keys(update).length > 0) result.reEncrypted++;
      }
      after = rows.at(-1)!.id;
    }
  } else {
    for (;;) {
      const rows = await prisma.helmetActivationSecret.findMany({
        where: { helmetId: { gt: after }, NOT: { pinCiphertext: { startsWith: prefix } } },
        select: { helmetId: true, pinCiphertext: true },
        orderBy: { helmetId: 'asc' },
        take: opts.batchSize,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        result.scanned++;
        const next = cipher.encrypt(cipher.decrypt(row.pinCiphertext, row.helmetId), row.helmetId);
        if (opts.dryRun) {
          result.reEncrypted++;
          continue;
        }
        const { count } = await prisma.helmetActivationSecret.updateMany({
          where: { helmetId: row.helmetId, pinCiphertext: row.pinCiphertext },
          data: { pinCiphertext: next },
        });
        if (count === 1) result.reEncrypted++;
        else result.skippedConcurrentChange++;
      }
      after = rows.at(-1)!.helmetId;
    }
  }

  if (!opts.dryRun)
    await app.get(AuditService).record({
      action: AuditAction.ENCRYPTION_KEYS_ROTATED,
      entityType: 'system',
      metadata: { ...result },
    });
  return result;
}
