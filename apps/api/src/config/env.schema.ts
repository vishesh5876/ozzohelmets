import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

/** "v1:<base64 32-byte key>,v2:<...>" — first entry is the active key. */
const keyring = (name: string) =>
  z
    .string()
    .min(1)
    .transform((raw, ctx) => {
      const entries = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const keys: { version: string; key: Buffer }[] = [];
      for (const entry of entries) {
        const idx = entry.indexOf(':');
        const version = entry.slice(0, idx);
        const key = Buffer.from(entry.slice(idx + 1), 'base64');
        if (idx <= 0 || !/^[a-z0-9]{1,8}$/i.test(version) || key.length !== 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${name} entries must be "<version>:<base64 32-byte key>"`,
          });
          return z.NEVER;
        }
        keys.push({ version, key });
      }
      if (keys.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must contain a key` });
        return z.NEVER;
      }
      return keys;
    });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.string().default('0.0.0.0'),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    REDIS_KEY_PREFIX: z.string().default('helmet:'),

    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: z.string().default('false'),
    TRUST_CLOUDFLARE: bool.default('false'),
    SWAGGER_ENABLED: bool.default('false'),
    PUBLIC_EMERGENCY_BASE_URL: z
      .string()
      .url()
      .transform((v) => v.replace(/\/+$/, '')),

    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    JWT_ISSUER: z.string().min(1).default('helmet-platform'),
    ADMIN_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    COOKIE_SECURE: bool.default('true'),
    COOKIE_DOMAIN: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    ADMIN_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    ADMIN_LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().min(30).default(900),

    JWT_CUSTOMER_ACCESS_SECRET: secret('JWT_CUSTOMER_ACCESS_SECRET'),
    JWT_CUSTOMER_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    CUSTOMER_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(180).default(30),

    /** Pepper for customer passwords and recovery codes (Argon2id `secret`). Rotating it invalidates them. */
    CUSTOMER_CREDENTIAL_PEPPER: secret('CUSTOMER_CREDENTIAL_PEPPER'),
    CUSTOMER_LOGIN_FAILURES_BEFORE_LOCK: z.coerce.number().int().min(1).max(50).default(5),
    CUSTOMER_LOGIN_LOCKOUT_BASE_SECONDS: z.coerce.number().int().min(5).default(60),
    CUSTOMER_LOGIN_LOCKOUT_MAX_SECONDS: z.coerce.number().int().min(60).default(3600),
    CUSTOMER_LOGIN_MAX_FAILURES_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(50),
    RECOVERY_FAILURES_BEFORE_LOCK: z.coerce.number().int().min(1).max(20).default(3),
    RECOVERY_LOCKOUT_BASE_SECONDS: z.coerce.number().int().min(10).default(900),
    RECOVERY_MAX_FAILURES_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(10),
    RECOVERY_RESET_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
    // Phase 5: support recovery grants, security-event retention, public abuse controls.
    RECOVERY_GRANT_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
    SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
    PUBLIC_MISS_LIMIT_PER_IP: z.coerce.number().int().min(5).max(10_000).default(30),
    PUBLIC_MISS_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
    PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED: z.coerce.number().int().min(1).max(1000).default(10),
    PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(3000),
    HELMET_HIGH_SCAN_THRESHOLD_24H: z.coerce.number().int().min(1).default(50),

    // Phase 6: scan recording, retention, risk thresholds, detection, worker intervals.
    SCAN_RECORDING_ENABLED: bool.default('true'),
    SCAN_DETAIL_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(180),
    /** 0 = keep daily aggregates forever. */
    ANALYTICS_AGGREGATE_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
    WORKER_JOB_RUN_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    RISK_HIGH_SCAN_HOURLY: z.coerce.number().int().min(1).default(50),
    RISK_HIGH_SCAN_DAILY: z.coerce.number().int().min(1).default(200),
    RISK_UNIQUE_IP_HOURLY: z.coerce.number().int().min(1).default(20),
    RISK_IP_CHURN_15MIN: z.coerce.number().int().min(1).default(10),
    RISK_IP_CHURN_MIN_RATIO: z.coerce.number().min(0).max(1).default(0.8),
    RISK_VERIFY_DAILY: z.coerce.number().int().min(1).default(30),
    RISK_VERIFY_BASELINE_MULTIPLIER: z.coerce.number().min(1).default(5),
    RISK_MIN_SCANS_FOR_EVALUATION: z.coerce.number().int().min(1).default(10),
    RISK_SIGNAL_CLEAR_AFTER_HOURS: z.coerce.number().int().min(1).default(24),
    RISK_ALERT_SUPPRESS_HOURS: z.coerce.number().int().min(0).default(24),
    ENUMERATION_INVALID_TOKEN_LIMIT: z.coerce.number().int().min(2).default(50),
    VALID_TOKEN_SCRAPE_LIMIT: z.coerce.number().int().min(2).default(100),
    VALID_TOKEN_SCRAPE_WINDOW_SECONDS: z.coerce.number().int().min(60).default(3600),
    VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER: z.coerce.number().int().min(2).default(5),
    RISK_EVALUATION_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(5),
    ANALYTICS_AGGREGATION_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(10),
    RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(60),
    /** In production, refuse to start when no proxy is trusted (set false only for direct exposure). */
    REQUIRE_TRUSTED_PROXY_IN_PRODUCTION: bool.default('true'),
    /** Sensitive actions (transfer, stolen, retire, …) require a password re-check this recent. */
    RECENT_AUTH_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
    TRANSFER_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    TRANSFER_FAILURES_BEFORE_LOCK: z.coerce.number().int().min(1).max(20).default(5),
    TRANSFER_LOCKOUT_BASE_SECONDS: z.coerce.number().int().min(10).default(900),
    TRANSFER_MAX_FAILURES_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(20),
    /** Phase 4 warranty: purchase dates may be at most this many days in the future (time zones). */
    WARRANTY_PURCHASE_DATE_TOLERANCE_DAYS: z.coerce.number().int().min(0).max(7).default(1),
    /** Replacement helmets: keep the original end date (default) or start a fresh model term. */
    WARRANTY_REPLACEMENT_POLICY: z
      .enum(['INHERIT_END_DATE', 'NEW_TERM'])
      .default('INHERIT_END_DATE'),
    WARRANTY_PROOF_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(100_000)
      .max(25_000_000)
      .default(10_485_760),
    PRODUCT_REPORTS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
    DEFAULT_PHONE_REGION: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default('IN'),

    ACTIVATION_FAILURES_BEFORE_LOCK: z.coerce.number().int().min(1).max(20).default(5),
    ACTIVATION_LOCKOUT_BASE_SECONDS: z.coerce.number().int().min(10).default(900),
    ACTIVATION_MAX_FAILURES_PER_CUSTOMER_PER_HOUR: z.coerce.number().int().min(1).default(10),
    ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(20),

    FILE_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    FILE_STORAGE_LOCAL_DIR: z.string().min(1).default('./storage'),
    PROFILE_PHOTO_MAX_BYTES: z.coerce.number().int().min(10_000).max(20_000_000).default(5_242_880),

    PUBLIC_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).max(60).default(30),
    SCAN_DEDUP_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

    PIN_HASH_PEPPER: secret('PIN_HASH_PEPPER'),
    PIN_ESCROW_KEYS: keyring('PIN_ESCROW_KEYS'),
    DATA_ENCRYPTION_KEYS: keyring('DATA_ENCRYPTION_KEYS'),
    IP_HASH_SECRET: secret('IP_HASH_SECRET'),
    PIN_ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19456),
    PIN_ARGON2_TIME_COST: z.coerce.number().int().min(1).default(2),

    BATCH_MAX_QUANTITY: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
    BATCH_GENERATION_CHUNK_SIZE: z.coerce.number().int().min(10).max(5000).default(500),

    THROTTLE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    THROTTLE_DEFAULT_LIMIT: z.coerce.number().int().min(1).default(300),
    THROTTLE_AUTH_LIMIT: z.coerce.number().int().min(1).default(10),
    THROTTLE_PUBLIC_LIMIT: z.coerce.number().int().min(1).default(300),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const devSecrets: [string, string][] = [
      ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
      ['JWT_CUSTOMER_ACCESS_SECRET', env.JWT_CUSTOMER_ACCESS_SECRET],
      ['CUSTOMER_CREDENTIAL_PEPPER', env.CUSTOMER_CREDENTIAL_PEPPER],
      ['PIN_HASH_PEPPER', env.PIN_HASH_PEPPER],
      ['IP_HASH_SECRET', env.IP_HASH_SECRET],
    ];
    for (const [name, value] of devSecrets) {
      if (value.startsWith('dev-only')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'dev-only secret used in production',
        });
      }
    }
    for (const name of ['PIN_ESCROW_KEYS', 'DATA_ENCRYPTION_KEYS'] as const) {
      if (env[name].some((k) => k.key.toString('utf8').startsWith('dev-only'))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'dev-only key used in production',
        });
      }
    }
    if (env.JWT_CUSTOMER_ACCESS_SECRET === env.JWT_ACCESS_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_CUSTOMER_ACCESS_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    // Client-IP identity (Phase 6): behind a reverse proxy, an untrusted proxy makes every visitor
    // share one IP (one rate-limit budget, one "visitor" in analytics); trusting every hop lets
    // clients spoof X-Forwarded-For. Require an explicit hop count / CIDR list, or Cloudflare.
    const trustProxy = env.TRUST_PROXY.trim().toLowerCase();
    if (trustProxy === 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY'],
        message:
          '"true" trusts any X-Forwarded-For (spoofable); use the number of proxy hops or the proxy CIDR list',
      });
    }
    if (
      env.REQUIRE_TRUSTED_PROXY_IN_PRODUCTION &&
      (trustProxy === 'false' || trustProxy === '' || trustProxy === '0') &&
      !env.TRUST_CLOUDFLARE
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY'],
        message:
          'no trusted proxy: behind a load balancer all clients would share one IP. Set TRUST_PROXY (hops or CIDR) or TRUST_CLOUDFLARE, or REQUIRE_TRUSTED_PROXY_IN_PRODUCTION=false if the API is exposed directly',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Validates process env at startup; throws a readable error listing every problem. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
