import { randomBytes } from 'node:crypto';
import { AesGcmCipher } from './encryption';

const k1 = { version: 'v1', key: randomBytes(32) };
const k2 = { version: 'v2', key: randomBytes(32) };

describe('AesGcmCipher', () => {
  it('round-trips and produces a fresh IV each time', () => {
    const cipher = new AesGcmCipher([k1]);
    const a = cipher.encrypt('73KP84QX');
    const b = cipher.encrypt('73KP84QX');
    expect(a).not.toEqual(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(cipher.decrypt(a)).toBe('73KP84QX');
    expect(a).not.toContain('73KP84QX');
  });

  it('binds ciphertext to associated data', () => {
    const cipher = new AesGcmCipher([k1]);
    const ct = cipher.encrypt('secret', 'helmet-a');
    expect(cipher.decrypt(ct, 'helmet-a')).toBe('secret');
    expect(() => cipher.decrypt(ct, 'helmet-b')).toThrow();
    expect(() => cipher.decrypt(ct)).toThrow();
  });

  it('detects tampering', () => {
    const cipher = new AesGcmCipher([k1]);
    const [v, iv, tag, data] = cipher.encrypt('blood group O+').split('.') as [
      string,
      string,
      string,
      string,
    ];
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] = (flipped[0] as number) ^ 0xff;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
    expect(() => cipher.decrypt('garbage')).toThrow('Malformed ciphertext');
  });

  it('supports key rotation: new key encrypts, old key still decrypts', () => {
    const old = new AesGcmCipher([k1]);
    const legacy = old.encrypt('legacy');
    const rotated = new AesGcmCipher([k2, k1]);
    expect(rotated.activeVersion).toBe('v2');
    expect(rotated.decrypt(legacy)).toBe('legacy');
    expect(rotated.encrypt('new').startsWith('v2.')).toBe(true);
    expect(() => new AesGcmCipher([k2]).decrypt(legacy)).toThrow('Unknown key version v1');
  });

  it('validates keys', () => {
    expect(() => new AesGcmCipher([])).toThrow();
    expect(() => new AesGcmCipher([{ version: 'v1', key: randomBytes(16) }])).toThrow();
  });
});
