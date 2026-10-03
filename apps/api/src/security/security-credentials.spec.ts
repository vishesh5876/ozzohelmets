import { normalizeRecoveryCode, RECOVERY_CODE_REGEX } from '@helmet/types';
import type { AppConfigService } from '../config/app-config.service';
import { HashingService } from './hashing.service';
import { escalatingLockSeconds } from './lockout';
import { passwordProblem } from './password-policy';
import { generateRecoveryCode } from './recovery-code';

const service = (pepper = 'customer-pepper-0123456789abcdefghijklmnop') =>
  new HashingService({
    get: (k: string) =>
      ({
        PIN_HASH_PEPPER: 'pin-pepper-0123456789abcdefghijklmnopq',
        CUSTOMER_CREDENTIAL_PEPPER: pepper,
        PIN_ARGON2_MEMORY_KIB: 8192,
        PIN_ARGON2_TIME_COST: 1,
      })[k],
  } as unknown as AppConfigService);

describe('customer password hashing', () => {
  it('uses peppered Argon2id and verifies correctly', async () => {
    const hashing = service();
    const hash = await hashing.hashCustomerSecret('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('horse');
    await expect(hashing.verifyCustomerSecret(hash, 'correct horse battery staple')).resolves.toBe(
      true,
    );
    await expect(hashing.verifyCustomerSecret(hash, 'correct horse battery stapl')).resolves.toBe(
      false,
    );
    await expect(
      service('another-pepper-0123456789abcdefghijklmno').verifyCustomerSecret(
        hash,
        'correct horse battery staple',
      ),
    ).resolves.toBe(false);
  });

  it('keeps customer and PIN peppers separate', async () => {
    const hashing = service();
    const pinHash = await hashing.hashPin('ABCD2345');
    await expect(hashing.verifyCustomerSecret(pinHash, 'ABCD2345')).resolves.toBe(false);
  });
});

describe('password policy', () => {
  it('accepts long passphrases without composition rules', () => {
    expect(passwordProblem('correct horse battery staple')).toBeNull();
    expect(passwordProblem('riding-to-goa-2026')).toBeNull();
    expect(passwordProblem('ಹೆಲ್ಮೆಟ್ ಸುರಕ್ಷತೆ')).toBeNull();
  });

  it.each([
    ['', 'Enter a password.'],
    ['short1', 'at least 8'],
    ['password', 'too common'],
    ['Password123', 'too common'],
    ['aaaaaaaaaa', 'repeating'],
    ['12345678', 'too common'],
    ['x'.repeat(129), 'at most 128'],
  ])('rejects %p', (pw, reason) => {
    expect(passwordProblem(pw)).toContain(reason);
  });

  it('rejects passwords containing the Helmet ID', () => {
    expect(passwordProblem('my-hm-a8f3-kl92-pass', { helmetCode: 'HM-A8F3-KL92' })).toContain(
      'Helmet ID',
    );
  });
});

describe('recovery codes', () => {
  it('are well-formed, unique and normalisable', () => {
    const codes = new Set(Array.from({ length: 20_000 }, generateRecoveryCode));
    expect(codes.size).toBe(20_000);
    for (const code of [...codes].slice(0, 500)) {
      expect(code).toMatch(RECOVERY_CODE_REGEX);
      expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code);
    }
    expect(normalizeRecoveryCode('RK-1111-0000-OOOO')).toBeNull();
    expect(normalizeRecoveryCode('RK-ABC')).toBeNull();
  });

  it('are stored only as hashes', async () => {
    const hashing = service();
    const code = generateRecoveryCode();
    const hash = await hashing.hashCustomerSecret(code);
    expect(hash).not.toContain(code);
    await expect(hashing.verifyCustomerSecret(hash, code)).resolves.toBe(true);
    await expect(hashing.verifyCustomerSecret(hash, generateRecoveryCode())).resolves.toBe(false);
  });
});

describe('escalating lockout', () => {
  it('locks every N failures with doubling cooldowns, never permanently', () => {
    expect(escalatingLockSeconds(4, 5, 60, 3600)).toBe(0);
    expect(escalatingLockSeconds(5, 5, 60, 3600)).toBe(60);
    expect(escalatingLockSeconds(10, 5, 60, 3600)).toBe(120);
    expect(escalatingLockSeconds(15, 5, 60, 3600)).toBe(240);
    expect(escalatingLockSeconds(500, 5, 60, 3600)).toBe(3600);
  });
});
