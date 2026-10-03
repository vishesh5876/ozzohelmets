import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyringEntry {
  version: string;
  key: Buffer;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM with versioned keys. Ciphertext format (ASCII):
 *   `<version>.<iv b64url>.<tag b64url>.<ciphertext b64url>`
 * The first keyring entry encrypts; any entry can decrypt, enabling key rotation.
 * Optional associated data binds a ciphertext to its record (e.g. helmet id) so ciphertexts
 * cannot be swapped between rows.
 */
export class AesGcmCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly active: KeyringEntry;

  constructor(keyring: KeyringEntry[]) {
    const first = keyring[0];
    if (!first) throw new Error('Keyring must contain at least one key');
    for (const entry of keyring) {
      if (entry.key.length !== 32) throw new Error(`Key ${entry.version} must be 32 bytes`);
      if (entry.version.includes('.')) throw new Error('Key version must not contain "."');
    }
    this.active = first;
    this.keys = new Map(keyring.map((k) => [k.version, k.key]));
  }

  encrypt(plaintext: string, associatedData?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.active.key, iv, { authTagLength: TAG_BYTES });
    if (associatedData) cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      this.active.version,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, associatedData?: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4) throw new Error('Malformed ciphertext');
    const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown key version ${version}`);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'), {
      authTagLength: TAG_BYTES,
    });
    if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  get activeVersion(): string {
    return this.active.version;
  }
}
