import {
  auditActionLabel,
  buildEmergencySummaryText,
  normalizeRecoveryGrant,
  RECOVERY_GRANT_REGEX,
  redactAuditMetadata,
  summarizeUserAgent,
} from '@helmet/types';
import { HashingService } from '../../security/hashing.service';
import { generateRecoveryGrantCredential } from '../../security/recovery-code';
import type { AppConfigService } from '../../config/app-config.service';

const hashing = new HashingService({
  get: (k: string) =>
    ({
      PIN_HASH_PEPPER: 'pin-pepper-0123456789abcdefghijklmnopq',
      CUSTOMER_CREDENTIAL_PEPPER: 'customer-pepper-0123456789abcdefghijklmnop',
    })[k],
} as unknown as AppConfigService);

describe('account recovery grant credential', () => {
  it('is AR- + 16 unambiguous CSPRNG symbols, unique, and normalises from user input', () => {
    const codes = new Set(Array.from({ length: 5000 }, generateRecoveryGrantCredential));
    expect(codes.size).toBe(5000);
    for (const c of [...codes].slice(0, 200)) {
      expect(c).toMatch(RECOVERY_GRANT_REGEX);
      expect(normalizeRecoveryGrant(c.toLowerCase().replace(/-/g, ' '))).toBe(c);
    }
    // The AR prefix is required so a recovery code (RK) is never treated as a grant.
    expect(normalizeRecoveryGrant('RK-AAAA-BBBB-CCCC-DDDD')).toBeNull();
    expect(normalizeRecoveryGrant('AR-AAAA-BBBB-CCCC')).toBeNull();
    expect(normalizeRecoveryGrant('AR-1111-0000-OOOO-IIII')).toBeNull();
  });

  it('is stored only as a peppered Argon2id hash', async () => {
    const credential = generateRecoveryGrantCredential();
    const hash = await hashing.hashCustomerSecret(credential);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(credential);
    await expect(hashing.verifyCustomerSecret(hash, credential)).resolves.toBe(true);
    await expect(
      hashing.verifyCustomerSecret(hash, generateRecoveryGrantCredential()),
    ).resolves.toBe(false);
  });
});

describe('security event redaction', () => {
  it('keeps only a coarse browser/OS summary of the user agent', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.70 Mobile Safari/537.36';
    expect(summarizeUserAgent(ua)).toBe('Chrome on Android');
    expect(summarizeUserAgent(ua)).not.toMatch(/Pixel|129|UQ1A/);
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(summarizeUserAgent('curl/8.0')).toBe('Other device');
    // Idempotent: the stored summary is returned unchanged when read back.
    for (const stored of ['Firefox on Windows', 'Samsung Internet on Android', 'Other device'])
      expect(summarizeUserAgent(stored)).toBe(stored);
    expect(summarizeUserAgent(null)).toBeNull();
  });

  it('redacts secret-looking audit metadata keys (recursively) but keeps flags', () => {
    expect(
      redactAuditMetadata({
        password: 'x',
        recoveryCode: 'RK-…',
        credentialHash: 'h',
        nested: { token: 't', ok: 1 },
        recoveryCodeRotated: true,
        email: 'a@example.com',
        from: 'ACTIVE',
      }),
    ).toEqual({
      password: '[redacted]',
      recoveryCode: '[redacted]',
      credentialHash: '[redacted]',
      nested: { token: '[redacted]', ok: 1 },
      recoveryCodeRotated: true,
      email: '[redacted]',
      from: 'ACTIVE',
    });
    expect(redactAuditMetadata(null)).toBeNull();
  });

  it('labels audit actions for humans', () => {
    expect(auditActionLabel('customer.recovery_grant.issued')).toBe(
      'Account recovery grant issued',
    );
    expect(auditActionLabel('something.new_thing')).toBe('Something new thing');
  });
});

describe('public emergency summary', () => {
  it('contains only fields present in the public DTO', () => {
    const text = buildEmergencySummaryText({
      profile: {
        name: 'Rahul Sharma',
        bloodGroupLabel: 'O+',
        allergies: ['Penicillin'],
        medicalConditions: ['Asthma'],
      },
      contacts: [{ name: 'Rajesh Sharma', relationship: 'Brother', phone: '+919800000001' }],
    });
    expect(text).toBe(
      [
        'Name: Rahul Sharma',
        'Blood Group: O+',
        'Allergies: Penicillin',
        'Medical Conditions: Asthma',
        'Emergency Contact: Rajesh Sharma (Brother) +919800000001',
        'Provided by the helmet owner; not verified.',
      ].join('\n'),
    );
    expect(buildEmergencySummaryText({})).toBe('');
    expect(buildEmergencySummaryText({ profile: { name: 'A' } })).not.toMatch(/Medications|Blood/);
  });
});
