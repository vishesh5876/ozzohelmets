import type { AppConfigService } from '../config/app-config.service';
import { HashingService } from './hashing.service';

function makeService(pepper = 'test-pepper-0123456789abcdefghijklmnop'): HashingService {
  const values: Record<string, unknown> = {
    PIN_HASH_PEPPER: pepper,
    PIN_ARGON2_MEMORY_KIB: 8192,
    PIN_ARGON2_TIME_COST: 1,
  };
  return new HashingService({ get: (k: string) => values[k] } as unknown as AppConfigService);
}

describe('HashingService', () => {
  const service = makeService();

  it('hashes activation PINs with Argon2id and never stores plaintext', async () => {
    const hash = await service.hashPin('73KP84QX');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('73KP84QX');
  });

  it('verifies the correct PIN and rejects others', async () => {
    const hash = await service.hashPin('73KP84QX');
    await expect(service.verifyPin(hash, '73KP84QX')).resolves.toBe(true);
    await expect(service.verifyPin(hash, '73KP84QY')).resolves.toBe(false);
    await expect(service.verifyPin(hash, '')).resolves.toBe(false);
  });

  it('salts: equal PINs produce different hashes', async () => {
    expect(await service.hashPin('AAAA2222')).not.toEqual(await service.hashPin('AAAA2222'));
  });

  it('requires the server-side pepper', async () => {
    const hash = await service.hashPin('73KP84QX');
    const otherPepper = makeService('different-pepper-0123456789abcdefghijk');
    await expect(otherPepper.verifyPin(hash, '73KP84QX')).resolves.toBe(false);
  });

  it('returns false instead of throwing on malformed hashes', async () => {
    await expect(service.verifyPin('not-a-hash', 'x')).resolves.toBe(false);
    await expect(service.verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('hashes passwords with Argon2id', async () => {
    const hash = await service.hashPassword('Correct-Horse-9');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(service.verifyPassword(hash, 'Correct-Horse-9')).resolves.toBe(true);
    await expect(service.verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('sha256 + constant-time compare', () => {
    const a = service.sha256('token');
    expect(a).toHaveLength(64);
    expect(service.safeEqualHex(a, service.sha256('token'))).toBe(true);
    expect(service.safeEqualHex(a, service.sha256('other'))).toBe(false);
  });
});
