import type { DecryptedProfile } from './decrypted-profile';
import {
  ageOn,
  buildPublicProfile,
  DEFAULT_VISIBILITY,
  type VisibilityFlags,
} from './public-profile';

const profile: DecryptedProfile = {
  id: 'p1',
  name: 'Rahul Sharma',
  bloodGroup: 'O_POSITIVE',
  gender: 'MALE',
  organDonor: true,
  dateOfBirth: '1990-05-14',
  allergies: ['Penicillin'],
  medicalConditions: ['Asthma'],
  medications: ['Salbutamol'],
  emergencyNotes: 'Inhaler in jacket',
  hasPhoto: true,
  photoKey: 'profile-photos/x.webp',
  photoContentType: 'image/webp',
  enabled: true,
  updatedAt: new Date(),
};
const contacts = [
  { name: 'Rajesh Sharma', relationship: 'Father', phone: '+919812345678', alternatePhone: null },
];
const all = Object.fromEntries(
  Object.keys(DEFAULT_VISIBILITY).map((k) => [k, true]),
) as VisibilityFlags;
const opts = { photoUrl: '/photo', today: new Date('2026-10-03T00:00:00Z') };

describe('buildPublicProfile (public data boundary)', () => {
  it('exposes nothing by default — not even keys', () => {
    const out = buildPublicProfile(profile, DEFAULT_VISIBILITY, contacts, opts);
    expect(out).toEqual({ profile: {} });
    expect(JSON.stringify(out)).not.toMatch(
      /Rahul|Penicillin|Asthma|Salbutamol|Inhaler|1990|9812345678|null/,
    );
  });

  it('exposes exactly the fields that are switched on', () => {
    const out = buildPublicProfile(
      profile,
      { ...DEFAULT_VISIBILITY, showName: true, showBloodGroup: true, showAllergies: true },
      contacts,
      opts,
    );
    expect(out).toEqual({
      profile: {
        name: 'Rahul Sharma',
        bloodGroup: 'O_POSITIVE',
        bloodGroupLabel: 'O+',
        allergies: ['Penicillin'],
      },
    });
  });

  it('exposes everything when all flags are on', () => {
    const out = buildPublicProfile(profile, all, contacts, opts);
    expect(out.profile).toEqual({
      name: 'Rahul Sharma',
      photoUrl: '/photo',
      bloodGroup: 'O_POSITIVE',
      bloodGroupLabel: 'O+',
      dateOfBirth: '1990-05-14',
      age: 36,
      gender: 'MALE',
      allergies: ['Penicillin'],
      medicalConditions: ['Asthma'],
      medications: ['Salbutamol'],
      emergencyNotes: 'Inhaler in jacket',
      organDonor: true,
    });
    expect(out.contacts).toEqual([
      { name: 'Rajesh Sharma', relationship: 'Father', phone: '+919812345678' },
    ]);
  });

  it('omits enabled-but-empty fields instead of returning null', () => {
    const empty: DecryptedProfile = {
      ...profile,
      name: null,
      bloodGroup: null,
      allergies: [],
      emergencyNotes: null,
      organDonor: null,
      hasPhoto: false,
      dateOfBirth: null,
    };
    const out = buildPublicProfile(empty, all, [], opts);
    for (const key of [
      'name',
      'bloodGroup',
      'allergies',
      'emergencyNotes',
      'organDonor',
      'photoUrl',
      'dateOfBirth',
      'age',
    ])
      expect(out.profile).not.toHaveProperty(key);
    expect(out).not.toHaveProperty('contacts');
  });

  it('includes alternate phone only when present', () => {
    const out = buildPublicProfile(
      profile,
      all,
      [{ ...contacts[0]!, alternatePhone: '+919800000000' }],
      opts,
    );
    expect(out.contacts?.[0]).toEqual({
      name: 'Rajesh Sharma',
      relationship: 'Father',
      phone: '+919812345678',
      alternatePhone: '+919800000000',
    });
  });

  it('computes age correctly around birthdays', () => {
    expect(ageOn('1990-10-04', new Date('2026-10-03T00:00:00Z'))).toBe(35);
    expect(ageOn('1990-10-03', new Date('2026-10-03T00:00:00Z'))).toBe(36);
    expect(ageOn('not-a-date', new Date())).toBeUndefined();
  });
});
