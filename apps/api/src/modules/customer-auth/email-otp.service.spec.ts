import type Redis from 'ioredis';
import { normalizeEmail } from '@helmet/types';
import type { AppConfigService } from '../../config/app-config.service';
import type { MailMessage, MailService } from '../../infrastructure/mail/mail.service';
import type { RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import { EmailOtpService } from './email-otp.service';

/** Minimal in-memory Redis covering the commands EmailOtpService uses. */
class MemoryRedis {
  data = new Map<string, string | Map<string, string>>();
  async set(key: string, value: string, ..._args: unknown[]) {
    const nx = _args.includes('NX');
    if (nx && this.data.has(key)) return null;
    this.data.set(key, value);
    return 'OK';
  }
  async get(key: string) {
    const v = this.data.get(key);
    return typeof v === 'string' ? v : null;
  }
  async ttl() {
    return 42;
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    return n;
  }
  private h(key: string) {
    let m = this.data.get(key);
    if (!(m instanceof Map)) this.data.set(key, (m = new Map()));
    return m;
  }
  async hset(key: string, obj: Record<string, string>) {
    for (const [k, v] of Object.entries(obj)) this.h(key).set(k, v);
    return 1;
  }
  async hget(key: string, field: string) {
    const m = this.data.get(key);
    return m instanceof Map ? (m.get(field) ?? null) : null;
  }
  async hincrby(key: string, field: string, by: number) {
    const m = this.h(key);
    const n = Number(m.get(field) ?? 0) + by;
    m.set(field, String(n));
    return n;
  }
  multi() {
    const ops: (() => Promise<unknown>)[] = [];
    const chain = {
      del: (k: string) => (ops.push(() => this.del(k)), chain),
      hset: (k: string, o: Record<string, string>) => (ops.push(() => this.hset(k, o)), chain),
      expire: () => chain,
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return chain;
  }
}

const env: Record<string, unknown> = {
  EMAIL_OTP_TTL_SECONDS: 600,
  EMAIL_OTP_RESEND_SECONDS: 60,
  EMAIL_OTP_MAX_ATTEMPTS: 3,
  EMAIL_OTP_MAX_SENDS_PER_ADDRESS_PER_HOUR: 5,
  EMAIL_OTP_MAX_SENDS_PER_IP_PER_HOUR: 20,
  EMAIL_PROOF_TTL_SECONDS: 1800,
  CUSTOMER_CREDENTIAL_PEPPER: 'test-pepper-test-pepper-test-pepper-0000',
};

function setup() {
  const sent: MailMessage[] = [];
  const redis = new MemoryRedis();
  const counts = new Map<string, number>();
  const limiter = {
    hit: async (key: string, limit: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { allowed: n <= limit, count: n, retryAfter: 100 };
    },
  } as unknown as RedisRateLimiter;
  const mail = {
    available: true,
    send: async (m: MailMessage) => void sent.push(m),
  } as unknown as MailService;
  const config = { get: (k: string) => env[k] } as unknown as AppConfigService;
  const svc = new EmailOtpService(config, mail, limiter, redis as unknown as Redis);
  const codeOf = (i = sent.length - 1) => /Your code: (\d{6})/.exec(sent[i]!.text)![1]!;
  return { svc, sent, redis, codeOf };
}

const email = normalizeEmail('Rider@Example.com')!;
const meta = { ipHash: 'ip1' } as never;

describe('EmailOtpService', () => {
  it('emails a six-digit code that verifies exactly once', async () => {
    const { svc, sent, codeOf } = setup();
    await expect(svc.send('signup', email, meta)).resolves.toEqual({
      expiresIn: 600,
      resendIn: 60,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email.email);
    const code = codeOf();
    expect(await svc.verify('signup', email, code)).toBe(true);
    expect(await svc.verify('signup', email, code)).toBe(false);
  });

  it('never stores the code or address in clear', async () => {
    const { svc, redis, codeOf } = setup();
    await svc.send('signup', email, meta);
    const dump = JSON.stringify(
      [...redis.data].map(([k, v]) => [k, v instanceof Map ? [...v] : v]),
    );
    expect(dump).not.toContain(codeOf());
    expect(dump.toLowerCase()).not.toContain('example.com');
  });

  it('is bound to its purpose and account', async () => {
    const { svc, codeOf } = setup();
    await svc.send('email-change', email, meta, { userId: 'u1' });
    const code = codeOf();
    expect(await svc.verify('signup', email, code)).toBe(false);
    expect(await svc.verify('email-change', email, code, 'u2')).toBe(false);
    expect(await svc.verify('email-change', email, code, 'u1')).toBe(true);
  });

  it('destroys the code after the allowed wrong attempts', async () => {
    const { svc, codeOf } = setup();
    await svc.send('password-reset', email, meta);
    const code = codeOf();
    const wrong = code === '000000' ? '111111' : '000000';
    expect(await svc.verify('password-reset', email, wrong)).toBe(false);
    expect(await svc.verify('password-reset', email, wrong)).toBe(false);
    expect(await svc.verify('password-reset', email, wrong)).toBe(false);
    expect(await svc.verify('password-reset', email, code)).toBe(false);
  });

  it('enforces the resend cool-down, and deliver:false sends nothing but answers the same', async () => {
    const { svc, sent } = setup();
    const quiet = await svc.send('password-reset', email, meta, { deliver: false });
    expect(quiet).toEqual({ expiresIn: 600, resendIn: 60 });
    expect(sent).toHaveLength(0);
    await expect(svc.send('password-reset', email, meta)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('proofs are bound to the address', async () => {
    const { svc } = setup();
    const { emailProof } = await svc.issueProof(email);
    expect(await svc.checkProof(emailProof, normalizeEmail('rider@example.com')!)).toBe(true);
    expect(await svc.checkProof(emailProof, normalizeEmail('other@example.com')!)).toBe(false);
    expect(await svc.checkProof(undefined, email)).toBe(false);
    await svc.consumeProof(emailProof);
    expect(await svc.checkProof(emailProof, email)).toBe(false);
  });
});
