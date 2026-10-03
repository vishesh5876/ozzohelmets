import type { AesGcmCipher } from '../../../security/encryption';

export type EncryptedProfileField =
  'dateOfBirth' | 'allergies' | 'medicalConditions' | 'medications' | 'emergencyNotes';

/**
 * Field-level encryption for emergency profiles using the versioned DATA_ENCRYPTION_KEYS keyring.
 * Associated data binds each ciphertext to its profile row AND field, so values cannot be moved
 * between users or swapped between columns. Decrypted values must never be logged or audited.
 */
export class ProfileCipher {
  constructor(private readonly cipher: AesGcmCipher) {}

  encryptText(
    profileId: string,
    field: EncryptedProfileField,
    value: string | null | undefined,
  ): string | null {
    if (value === null || value === undefined || value === '') return null;
    return this.cipher.encrypt(value, this.aad(profileId, field));
  }

  encryptList(
    profileId: string,
    field: EncryptedProfileField,
    values: string[] | null | undefined,
  ): string | null {
    if (!values || values.length === 0) return null;
    return this.cipher.encrypt(JSON.stringify(values), this.aad(profileId, field));
  }

  decryptText(
    profileId: string,
    field: EncryptedProfileField,
    ciphertext: string | null,
  ): string | null {
    return ciphertext ? this.cipher.decrypt(ciphertext, this.aad(profileId, field)) : null;
  }

  decryptList(
    profileId: string,
    field: EncryptedProfileField,
    ciphertext: string | null,
  ): string[] {
    if (!ciphertext) return [];
    const parsed: unknown = JSON.parse(this.cipher.decrypt(ciphertext, this.aad(profileId, field)));
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  }

  private aad(profileId: string, field: EncryptedProfileField): string {
    return `emergency_profile:${profileId}:${field}`;
  }
}
