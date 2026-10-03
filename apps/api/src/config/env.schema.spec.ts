import { validateEnv } from './env.schema';

const key = (seed: string) => Buffer.alloc(32, seed).toString('base64');

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  PUBLIC_EMERGENCY_BASE_URL: 'https://safe.example.com/',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_CUSTOMER_ACCESS_SECRET: 'c'.repeat(40),
  OTP_HASH_SECRET: 'o'.repeat(40),
  PIN_HASH_PEPPER: 'y'.repeat(40),
  IP_HASH_SECRET: 'z'.repeat(40),
  PIN_ESCROW_KEYS: `v2:${key('a')},v1:${key('b')}`,
  DATA_ENCRYPTION_KEYS: `v1:${key('c')}`,
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
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', OTP_PROVIDER: 'development' }),
    ).toThrow(/OTP_PROVIDER/);
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_CUSTOMER_ACCESS_SECRET: base.JWT_ACCESS_SECRET,
      }),
    ).toThrow(/must differ/);
  });
});
