import { validateEnv } from './env.schema';

const key = (seed: string) => Buffer.alloc(32, seed).toString('base64');

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  PUBLIC_EMERGENCY_BASE_URL: 'https://safe.example.com/',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_CUSTOMER_ACCESS_SECRET: 'c'.repeat(40),
  CUSTOMER_CREDENTIAL_PEPPER: 'o'.repeat(40),
  PIN_HASH_PEPPER: 'y'.repeat(40),
  IP_HASH_SECRET: 'z'.repeat(40),
  PIN_ESCROW_KEYS: `v2:${key('a')},v1:${key('b')}`,
  DATA_ENCRYPTION_KEYS: `v1:${key('c')}`,
};

/** A configuration that passes every production guard. */
const prod = {
  ...base,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://helmet:S7rong-Db-Passw0rd-xyz@postgres:5432/helmet',
  CORS_ORIGINS: 'https://admin.example.com,https://safe.example.com',
  PUBLIC_EMERGENCY_BASE_URL: 'https://safe.example.com',
  TRUST_PROXY: '172.30.0.0/16',
};

describe('validateEnv', () => {
  it('parses a valid environment with defaults', () => {
    const env = validateEnv(base);
    expect(env.API_PORT).toBe(4000);
    expect(env.PUBLIC_EMERGENCY_BASE_URL).toBe('https://safe.example.com');
    expect(env.PIN_ESCROW_KEYS.map((k) => k.version)).toEqual(['v2', 'v1']);
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it('lists every problem', () => {
    expect(() =>
      validateEnv({ ...base, JWT_ACCESS_SECRET: 'short', DATABASE_URL: 'nope' }),
    ).toThrow(/JWT_ACCESS_SECRET[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*JWT_ACCESS_SECRET/);
  });

  it('rejects malformed keyrings', () => {
    expect(() => validateEnv({ ...base, PIN_ESCROW_KEYS: 'v1:dG9vLXNob3J0' })).toThrow(
      /PIN_ESCROW_KEYS/,
    );
  });

  it('refuses dev-only secrets and insecure cookies in production', () => {
    const devKey = Buffer.from('dev-only-pin-escrow-key-32bytes!').toString('base64');
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: `dev-only-${'x'.repeat(40)}`,
        PIN_ESCROW_KEYS: `v1:${devKey}`,
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/JWT_ACCESS_SECRET[\s\S]*PIN_ESCROW_KEYS[\s\S]*COOKIE_SECURE/);
    expect(() => validateEnv(prod)).not.toThrow();
    expect(() =>
      validateEnv({ ...prod, JWT_CUSTOMER_ACCESS_SECRET: base.JWT_ACCESS_SECRET }),
    ).toThrow(/must differ/);
  });

  it('requires an explicit, non-spoofable proxy setting in production', () => {
    expect(() => validateEnv({ ...prod, TRUST_PROXY: 'false' })).toThrow(
      /TRUST_PROXY: no trusted proxy/,
    );
    expect(() => validateEnv({ ...prod, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(() => validateEnv({ ...prod, TRUST_PROXY: '10.0.0.0/8' })).not.toThrow();
    expect(() =>
      validateEnv({ ...prod, TRUST_PROXY: 'false', TRUST_CLOUDFLARE: 'true' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...prod, TRUST_PROXY: 'false', REQUIRE_TRUSTED_PROXY_IN_PRODUCTION: 'false' }),
    ).not.toThrow();
    // Development keeps working without a proxy.
    expect(() => validateEnv(base)).not.toThrow();
  });

  describe('Phase 7 production guards', () => {
    const fails = (overrides: Record<string, string>, re: RegExp) =>
      expect(() => validateEnv({ ...prod, ...overrides })).toThrow(re);

    it.each([
      'postgresql://helmet:postgres@postgres:5432/helmet',
      'postgresql://postgres:password@postgres:5432/helmet',
      'postgresql://helmet:short@postgres:5432/helmet',
      'postgresql://helmet:dev-only-0123456789abcdef@postgres:5432/helmet',
      'postgresql://helmet@postgres:5432/helmet',
    ])('rejects a weak database password: %s', (url) =>
      fails({ DATABASE_URL: url }, /DATABASE_URL/),
    );

    it('requires explicit HTTPS CORS origins without wildcards', () => {
      fails({ CORS_ORIGINS: '' }, /CORS_ORIGINS: set the exact/);
      fails({ CORS_ORIGINS: '*' }, /wildcard/);
      fails({ CORS_ORIGINS: 'https://*.example.com' }, /wildcard/);
      fails({ CORS_ORIGINS: 'http://admin.example.com' }, /must be https/);
      fails({ CORS_ORIGINS: 'https://admin.example.com/app' }, /must be https/);
    });

    it('requires an HTTPS, non-local public emergency URL', () => {
      fails(
        { PUBLIC_EMERGENCY_BASE_URL: 'http://safe.example.com' },
        /PUBLIC_EMERGENCY_BASE_URL: must use https/,
      );
      fails({ PUBLIC_EMERGENCY_BASE_URL: 'https://localhost:3001' }, /not localhost/);
    });

    it('keeps Swagger off unless explicitly allowed', () => {
      fails({ SWAGGER_ENABLED: 'true' }, /SWAGGER_ENABLED/);
      expect(() =>
        validateEnv({ ...prod, SWAGGER_ENABLED: 'true', ALLOW_SWAGGER_IN_PRODUCTION: 'true' }),
      ).not.toThrow();
    });

    it('refuses one secret reused across functions and shared key material', () => {
      fails(
        { IP_HASH_SECRET: base.PIN_HASH_PEPPER },
        /IP_HASH_SECRET: must differ from PIN_HASH_PEPPER/,
      );
      fails({ METRICS_TOKEN: base.JWT_ACCESS_SECRET }, /METRICS_TOKEN: must differ/);
      fails(
        { DATA_ENCRYPTION_KEYS: base.PIN_ESCROW_KEYS.split(',')[0]! },
        /DATA_ENCRYPTION_KEYS: must not reuse/,
      );
    });

    it('none of these apply outside production', () => {
      expect(() =>
        validateEnv({
          ...base,
          CORS_ORIGINS: '*',
          PUBLIC_EMERGENCY_BASE_URL: 'http://localhost:3001',
        }),
      ).not.toThrow();
    });
  });
});
