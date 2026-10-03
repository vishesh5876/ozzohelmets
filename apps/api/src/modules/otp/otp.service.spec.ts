import { ErrorCode } from '@helmet/types';
import type { AppConfigService } from '../../config/app-config.service';
import type { RateLimitResult, RedisRateLimiter } from '../../security/redis-rate-limiter.service';
import type { OtpProvider } from './otp.providers';
import { generateOtp, OtpService } from './otp.service';
import { InMemoryOtpStore } from './otp.store';

class FakeLimiter {
  counts = new Map<string, number>();
  async hit(key: string, limit: number): Promise<RateLimitResult> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { allowed: count <= limit, count, retryAfter: 30 };
  }
}

const CONFIG: Record<string, unknown> = {
  OTP_HASH_SECRET: 'unit-test-otp-secret-0123456789abcdefghijk',
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 3,
  OTP_RESEND_COOLDOWN_SECONDS: 60,
  OTP_MAX_PER_MOBILE_PER_HOUR: 3,
  OTP_MAX_PER_IP_PER_HOUR: 5,
  OTP_GLOBAL_MAX_PER_MINUTE: 100,
};
const MOBILE = '+919876543210';

function setup(options: { dev?: boolean } = {}) {
  let now = 1_000_000;
  const store = new InMemoryOtpStore(() => now);
  const limiter = new FakeLimiter();
  const delivered: { mobile: string; code: string }[] = [];
  const provider: OtpProvider = {
    name: 'fake',
    exposesCodeForDevelopment: options.dev ?? true,
    deliver: async (mobile, code) => {
      delivered.push({ mobile, code });
    },
  };
  const service = new OtpService(
    store,
    provider,
    limiter as unknown as RedisRateLimiter,
    { get: (k: string) => CONFIG[k] } as unknown as AppConfigService,
  );
  return {
    service,
    store,
    limiter,
    delivered,
    advance: (ms: number) => (now += ms),
    resetCooldown: () =>
      limiter.counts.forEach((_v, k) => k.startsWith('otp:cooldown') && limiter.counts.delete(k)),
  };
}

describe('generateOtp', () => {
  it('produces 6-digit codes covering the full range', () => {
    const codes = Array.from({ length: 20_000 }, generateOtp);
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(19_500);
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
  });
});

describe('OtpService', () => {
  it('issues and verifies a code exactly once', async () => {
    const { service, delivered } = setup();
    const issued = await service.issue(MOBILE, 'ip');
    expect(issued).toMatchObject({ expiresIn: 300, resendAfter: 60 });
    expect(issued.devOtp).toBe(delivered[0]!.code);
    await expect(service.verify(MOBILE, delivered[0]!.code)).resolves.toBeUndefined();
    await expect(service.verify(MOBILE, delivered[0]!.code)).rejects.toMatchObject({
      code: ErrorCode.OTP_EXPIRED,
    });
  });

  it('never returns the code without a development provider', async () => {
    const { service } = setup({ dev: false });
    expect((await service.issue(MOBILE, 'ip')).devOtp).toBeUndefined();
  });

  it('stores only a hash of the code', async () => {
    const { service, store, delivered } = setup();
    await service.issue(MOBILE, 'ip');
    const internal = JSON.stringify([
      ...(store as unknown as { records: Map<string, unknown> }).records.entries(),
    ]);
    expect(internal).not.toContain(delivered[0]!.code);
    expect(internal).not.toContain('9876543210');
  });

  it('expires codes after the TTL', async () => {
    const { service, delivered, advance } = setup();
    await service.issue(MOBILE, 'ip');
    advance(301_000);
    await expect(service.verify(MOBILE, delivered[0]!.code)).rejects.toMatchObject({
      code: ErrorCode.OTP_EXPIRED,
    });
  });

  it('caps verification attempts and burns the code', async () => {
    const { service, delivered } = setup();
    await service.issue(MOBILE, 'ip');
    const wrong = delivered[0]!.code === '000000' ? '111111' : '000000';
    await expect(service.verify(MOBILE, wrong)).rejects.toMatchObject({
      code: ErrorCode.INVALID_OTP,
      details: { attemptsRemaining: 2 },
    });
    await expect(service.verify(MOBILE, wrong)).rejects.toMatchObject({
      details: { attemptsRemaining: 1 },
    });
    await expect(service.verify(MOBILE, wrong)).rejects.toMatchObject({
      code: ErrorCode.OTP_TOO_MANY_ATTEMPTS,
    });
    await expect(service.verify(MOBILE, delivered[0]!.code)).rejects.toMatchObject({
      code: ErrorCode.OTP_EXPIRED,
    });
  });

  it('invalidates the previous code when a new one is issued', async () => {
    const { service, delivered, resetCooldown } = setup();
    await service.issue(MOBILE, 'ip');
    resetCooldown();
    await service.issue(MOBILE, 'ip');
    const [first, second] = delivered;
    if (first!.code !== second!.code) {
      await expect(service.verify(MOBILE, first!.code)).rejects.toMatchObject({
        code: ErrorCode.INVALID_OTP,
      });
    }
    await expect(service.verify(MOBILE, second!.code)).resolves.toBeUndefined();
  });

  it('enforces the resend cooldown and per-mobile limit', async () => {
    const { service, resetCooldown } = setup();
    await service.issue(MOBILE, 'ip');
    await expect(service.issue(MOBILE, 'ip')).rejects.toMatchObject({
      code: ErrorCode.OTP_RATE_LIMITED,
    });
    resetCooldown();
    await service.issue(MOBILE, 'ip');
    resetCooldown();
    await service.issue(MOBILE, 'ip');
    resetCooldown();
    await expect(service.issue(MOBILE, 'ip')).rejects.toMatchObject({
      code: ErrorCode.OTP_RATE_LIMITED,
    });
  });

  it('enforces the per-IP limit across numbers', async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i++) await service.issue(`+91987654320${i}`, 'same-ip');
    await expect(service.issue('+919876543209', 'same-ip')).rejects.toMatchObject({
      code: ErrorCode.OTP_RATE_LIMITED,
    });
  });

  it('rejects malformed codes without consuming attempts', async () => {
    const { service, delivered } = setup();
    await service.issue(MOBILE, 'ip');
    await expect(service.verify(MOBILE, '12ab')).rejects.toMatchObject({
      code: ErrorCode.INVALID_OTP,
    });
    await expect(service.verify(MOBILE, delivered[0]!.code)).resolves.toBeUndefined();
  });

  it('removes the stored code when delivery fails', async () => {
    const { service, store } = setup();
    (service as unknown as { provider: OtpProvider }).provider.deliver = async () => {
      throw new Error('sms down');
    };
    await expect(service.issue(MOBILE, 'ip')).rejects.toThrow('sms down');
    expect(store.size()).toBe(0);
  });
});
