/**
 * Deterministic environment for integration tests. Uses a dedicated database and Redis DB so
 * tests never touch development data. Override with TEST_DATABASE_URL / TEST_REDIS_URL.
 */
const key = (seed: string) => Buffer.alloc(32, seed).toString('base64');

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgresql://helmet:helmet@localhost:5432/helmet_platform_test?schema=public',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
  REDIS_KEY_PREFIX: 'helmet-test:',
  CORS_ORIGINS: 'http://localhost:3000',
  PUBLIC_EMERGENCY_BASE_URL: 'https://safe.example.test',
  SWAGGER_ENABLED: 'false',
  JWT_ACCESS_SECRET: 'test-jwt-secret-0123456789abcdefghijklmnop',
  JWT_ACCESS_TTL_SECONDS: '900',
  COOKIE_SECURE: 'false',
  ADMIN_LOGIN_MAX_ATTEMPTS: '3',
  JWT_CUSTOMER_ACCESS_SECRET: 'test-customer-jwt-secret-0123456789abcdefgh',
  CUSTOMER_CREDENTIAL_PEPPER: 'test-customer-pepper-0123456789abcdefghijk',
  CUSTOMER_LOGIN_FAILURES_BEFORE_LOCK: '3',
  RECOVERY_FAILURES_BEFORE_LOCK: '3',
  ACTIVATION_FAILURES_BEFORE_LOCK: '3',
  ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR: '10',
  TRANSFER_FAILURES_BEFORE_LOCK: '3',
  FILE_STORAGE_LOCAL_DIR: '/tmp/helmet-test-storage',
  PIN_HASH_PEPPER: 'test-pin-pepper-0123456789abcdefghijklmnop',
  PIN_ESCROW_KEYS: `v1:${key('p')}`,
  DATA_ENCRYPTION_KEYS: `v1:${key('d')}`,
  IP_HASH_SECRET: 'test-ip-hash-secret-0123456789abcdefghijk',
  PIN_ARGON2_MEMORY_KIB: '8192',
  PIN_ARGON2_TIME_COST: '1',
  BATCH_MAX_QUANTITY: '1000',
  BATCH_GENERATION_CHUNK_SIZE: '40',
  THROTTLE_DEFAULT_LIMIT: '10000',
  THROTTLE_AUTH_LIMIT: '1000',
  THROTTLE_PUBLIC_LIMIT: '25',
  PUBLIC_MISS_LIMIT_PER_IP: '6',
  PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED: '2',
  RECOVERY_GRANT_TTL_MINUTES: '30',
  // Phase 6: small thresholds so detection scenarios stay fast and deterministic.
  ENUMERATION_INVALID_TOKEN_LIMIT: '5',
  VALID_TOKEN_SCRAPE_LIMIT: '4',
  VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER: '2',
  RISK_HIGH_SCAN_HOURLY: '20',
  RISK_HIGH_SCAN_DAILY: '60',
  RISK_UNIQUE_IP_HOURLY: '8',
  RISK_IP_CHURN_15MIN: '6',
  RISK_VERIFY_DAILY: '10',
  RISK_MIN_SCANS_FOR_EVALUATION: '5',
};
