import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';

export interface OtpRecord {
  /** HMAC of the code — the plaintext code is never stored. */
  hash: string;
  attempts: number;
}

export type OtpAttemptResult =
  | { status: 'OK' }
  | { status: 'MISMATCH'; attemptsRemaining: number }
  | { status: 'EXPIRED' }
  | { status: 'LOCKED' };

export interface OtpStore {
  /** Saves a fresh code, replacing (invalidating) any previous one for the key. */
  save(key: string, record: OtpRecord, ttlSeconds: number): Promise<void>;
  /** Atomically checks a candidate; consumes the code on success or when attempts run out. */
  attempt(key: string, candidateHash: string, maxAttempts: number): Promise<OtpAttemptResult>;
  delete(key: string): Promise<void>;
}

export const OTP_STORE = Symbol('OTP_STORE');

const ATTEMPT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'EXPIRED', 0} end
local rec = cjson.decode(raw)
local max = tonumber(ARGV[2])
if rec.attempts >= max then redis.call('DEL', KEYS[1]); return {'LOCKED', 0} end
if rec.hash == ARGV[1] then redis.call('DEL', KEYS[1]); return {'OK', 0} end
rec.attempts = rec.attempts + 1
if rec.attempts >= max then redis.call('DEL', KEYS[1]); return {'LOCKED', 0} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then redis.call('DEL', KEYS[1]); return {'EXPIRED', 0} end
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)
return {'MISMATCH', max - rec.attempts}
`;

/** Redis implementation: TTL handles expiry, a Lua script makes attempt counting race-free. */
@Injectable()
export class RedisOtpStore implements OtpStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async save(key: string, record: OtpRecord, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
  }

  async attempt(
    key: string,
    candidateHash: string,
    maxAttempts: number,
  ): Promise<OtpAttemptResult> {
    const [status, remaining] = (await this.redis.eval(
      ATTEMPT_SCRIPT,
      1,
      key,
      candidateHash,
      String(maxAttempts),
    )) as [string, number];
    if (status === 'OK') return { status: 'OK' };
    if (status === 'MISMATCH') return { status: 'MISMATCH', attemptsRemaining: remaining };
    if (status === 'LOCKED') return { status: 'LOCKED' };
    return { status: 'EXPIRED' };
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/** In-memory store with an injectable clock, used by unit tests. */
export class InMemoryOtpStore implements OtpStore {
  private readonly records = new Map<string, OtpRecord & { expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async save(key: string, record: OtpRecord, ttlSeconds: number): Promise<void> {
    this.records.set(key, { ...record, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async attempt(
    key: string,
    candidateHash: string,
    maxAttempts: number,
  ): Promise<OtpAttemptResult> {
    const rec = this.records.get(key);
    if (!rec || rec.expiresAt <= this.now()) {
      this.records.delete(key);
      return { status: 'EXPIRED' };
    }
    if (rec.attempts >= maxAttempts) {
      this.records.delete(key);
      return { status: 'LOCKED' };
    }
    if (rec.hash === candidateHash) {
      this.records.delete(key);
      return { status: 'OK' };
    }
    rec.attempts += 1;
    if (rec.attempts >= maxAttempts) {
      this.records.delete(key);
      return { status: 'LOCKED' };
    }
    return { status: 'MISMATCH', attemptsRemaining: maxAttempts - rec.attempts };
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  size(): number {
    return this.records.size;
  }
}
