import type { EmergencyProfile } from '@prisma/client';
import type { BloodGroup, Gender } from '@helmet/types';
import type { ProfileCipher } from './profile-cipher';

/** In-memory, decrypted view of a profile row. Never cache, log or audit this object. */
export interface DecryptedProfile {
  id: string;
  name: string | null;
  bloodGroup: BloodGroup | null;
  gender: Gender | null;
  organDonor: boolean | null;
  dateOfBirth: string | null;
  allergies: string[];
  medicalConditions: string[];
  medications: string[];
  emergencyNotes: string | null;
  hasPhoto: boolean;
  photoKey: string | null;
  photoContentType: string | null;
  enabled: boolean;
  updatedAt: Date;
}

export function decryptProfile(row: EmergencyProfile, cipher: ProfileCipher): DecryptedProfile {
  return {
    id: row.id,
    name: row.name,
    bloodGroup: row.bloodGroup,
    gender: row.gender,
    organDonor: row.organDonor,
    dateOfBirth: cipher.decryptText(row.id, 'dateOfBirth', row.dateOfBirthCiphertext),
    allergies: cipher.decryptList(row.id, 'allergies', row.allergiesCiphertext),
    medicalConditions: cipher.decryptList(
      row.id,
      'medicalConditions',
      row.medicalConditionsCiphertext,
    ),
    medications: cipher.decryptList(row.id, 'medications', row.medicationsCiphertext),
    emergencyNotes: cipher.decryptText(row.id, 'emergencyNotes', row.emergencyNotesCiphertext),
    hasPhoto: row.photoKey !== null,
    photoKey: row.photoKey,
    photoContentType: row.photoContentType,
    enabled: row.emergencyProfileEnabled,
    updatedAt: row.updatedAt,
  };
}
