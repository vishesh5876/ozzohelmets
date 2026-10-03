import {
  BLOOD_GROUP_LABELS,
  type EmergencyVisibilityDto,
  type PublicEmergencyContactDto,
  type PublicEmergencyProfileDto,
} from '@helmet/types';
import type { DecryptedProfile } from './decrypted-profile';

export interface PublicContactSource {
  name: string;
  relationship: string;
  phone: string;
  alternatePhone: string | null;
}

export type VisibilityFlags = Omit<EmergencyVisibilityDto, 'confirmedAt'>;

/** Everything hidden — the default when no visibility row exists. */
export const DEFAULT_VISIBILITY: VisibilityFlags = {
  showName: false,
  showPhoto: false,
  showBloodGroup: false,
  showDateOfBirth: false,
  showGender: false,
  showAllergies: false,
  showMedicalConditions: false,
  showMedications: false,
  showEmergencyNotes: false,
  showOrganDonor: false,
  showEmergencyContacts: false,
};

export function ageOn(dateOfBirth: string, today: Date): number | undefined {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return undefined;
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 150 ? age : undefined;
}

/**
 * The public data boundary. Builds the QR-page payload from an allow-list: a field is copied
 * only when its visibility flag is on AND it has a value. Hidden or empty fields are omitted
 * entirely (never `null`), so a response reveals nothing about what the owner chose to hide.
 */
export function buildPublicProfile(
  profile: DecryptedProfile,
  visibility: VisibilityFlags,
  contacts: PublicContactSource[],
  options: { photoUrl: string; today?: Date },
): { profile: PublicEmergencyProfileDto; contacts?: PublicEmergencyContactDto[] } {
  const out: PublicEmergencyProfileDto = {};
  if (visibility.showName && profile.name) out.name = profile.name;
  if (visibility.showPhoto && profile.hasPhoto) out.photoUrl = options.photoUrl;
  if (visibility.showBloodGroup && profile.bloodGroup) {
    out.bloodGroup = profile.bloodGroup;
    out.bloodGroupLabel = BLOOD_GROUP_LABELS[profile.bloodGroup];
  }
  if (visibility.showDateOfBirth && profile.dateOfBirth) {
    out.dateOfBirth = profile.dateOfBirth;
    const age = ageOn(profile.dateOfBirth, options.today ?? new Date());
    if (age !== undefined) out.age = age;
  }
  if (visibility.showGender && profile.gender) out.gender = profile.gender;
  if (visibility.showAllergies && profile.allergies.length) out.allergies = [...profile.allergies];
  if (visibility.showMedicalConditions && profile.medicalConditions.length)
    out.medicalConditions = [...profile.medicalConditions];
  if (visibility.showMedications && profile.medications.length)
    out.medications = [...profile.medications];
  if (visibility.showEmergencyNotes && profile.emergencyNotes)
    out.emergencyNotes = profile.emergencyNotes;
  if (visibility.showOrganDonor && profile.organDonor !== null) out.organDonor = profile.organDonor;

  const result: { profile: PublicEmergencyProfileDto; contacts?: PublicEmergencyContactDto[] } = {
    profile: out,
  };
  if (visibility.showEmergencyContacts && contacts.length) {
    result.contacts = contacts.map((c) => ({
      name: c.name,
      relationship: c.relationship,
      phone: c.phone,
      ...(c.alternatePhone ? { alternatePhone: c.alternatePhone } : {}),
    }));
  }
  return result;
}
