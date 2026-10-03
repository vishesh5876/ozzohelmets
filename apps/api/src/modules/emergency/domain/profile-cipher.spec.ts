import { randomBytes } from 'node:crypto';
import { AesGcmCipher } from '../../../security/encryption';
import { ProfileCipher } from './profile-cipher';

const cipher = new ProfileCipher(new AesGcmCipher([{ version: 'v1', key: randomBytes(32) }]));

describe('ProfileCipher', () => {
  it('round-trips text and lists and never stores plaintext', () => {
    const notes = cipher.encryptText('p1', 'emergencyNotes', 'Diabetic — insulin in left pocket');
    const allergies = cipher.encryptList('p1', 'allergies', ['Penicillin', 'Peanuts']);
    expect(notes).not.toContain('insulin');
    expect(allergies).not.toContain('Penicillin');
    expect(allergies?.startsWith('v1.')).toBe(true);
    expect(cipher.decryptText('p1', 'emergencyNotes', notes)).toBe(
      'Diabetic — insulin in left pocket',
    );
    expect(cipher.decryptList('p1', 'allergies', allergies)).toEqual(['Penicillin', 'Peanuts']);
  });

  it('binds ciphertext to its profile and field', () => {
    const ct = cipher.encryptList('p1', 'allergies', ['Penicillin']);
    expect(() => cipher.decryptList('p2', 'allergies', ct)).toThrow();
    expect(() => cipher.decryptList('p1', 'medications', ct)).toThrow();
  });

  it('stores empty values as null', () => {
    expect(cipher.encryptText('p1', 'emergencyNotes', '')).toBeNull();
    expect(cipher.encryptList('p1', 'allergies', [])).toBeNull();
    expect(cipher.decryptList('p1', 'allergies', null)).toEqual([]);
    expect(cipher.decryptText('p1', 'dateOfBirth', null)).toBeNull();
  });
});
