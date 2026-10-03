import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { ErrorCode } from '@helmet/types';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../common/http/app.exception';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.constants';
import { opaqueToken } from './secure-random';

export type RecentAuthRealm = 'customer' | 'admin';

interface RecentAuthTicket {
  subjectId: string;
  sessionId: string | null;
  generation: string;
}

/** Header carrying the recent-auth token on sensitive requests. */
export const RECENT_AUTH_HEADER = 'x-recent-auth';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * "Re-entered the password within the last N minutes" proof for sensitive actions.
 * Tokens are 256-bit random, stored only as SHA-256 keys in Redis with a short TTL, bound to the
 * subject and (for customers) the session, and reusable until they expire. Bumping the subject's
 * generation (password change/reset, logout-all) invalidates every outstanding token at once.
 */
@Injectable()
export class RecentAuthService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfigService,
  ) {}

  get ttlSeconds(): number {
    return this.config.get('RECENT_AUTH_TTL_SECONDS');
  }

  async issue(
    realm: RecentAuthRealm,
    subjectId: string,
    sessionId: string | null,
  ): Promise<{ recentAuthToken: string; expiresIn: number }> {
    const token = opaqueToken(32);
    const ticket: RecentAuthTicket = {
      subjectId,
      sessionId,
      generation: await this.generation(realm, subjectId),
    };
    await this.redis.set(this.key(realm, token), JSON.stringify(ticket), 'EX', this.ttlSeconds);
    return { recentAuthToken: token, expiresIn: this.ttlSeconds };
  }

  /** Throws RECENT_AUTH_REQUIRED unless `token` is a live token for this subject (and session). */
  async assert(
    realm: RecentAuthRealm,
    subjectId: string,
    sessionId: string | null,
    token: string | undefined,
  ): Promise<void> {
    const raw = token && token.length <= 128 ? await this.redis.get(this.key(realm, token)) : null;
    const ticket = raw ? (JSON.parse(raw) as RecentAuthTicket) : null;
    const valid =
      ticket !== null &&
      ticket.subjectId === subjectId &&
      (ticket.sessionId === null || ticket.sessionId === sessionId) &&
      ticket.generation === (await this.generation(realm, subjectId));
    if (!valid) {
      throw new AppException(
        ErrorCode.RECENT_AUTH_REQUIRED,
        'Confirm your password to continue.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Invalidates every outstanding token of the subject. */
  async revokeAll(realm: RecentAuthRealm, subjectId: string): Promise<void> {
    const key = this.generationKey(realm, subjectId);
    await this.redis
      .multi()
      .incr(key)
      .expire(key, this.ttlSeconds * 4)
      .exec();
  }

  private async generation(realm: RecentAuthRealm, subjectId: string): Promise<string> {
    return (await this.redis.get(this.generationKey(realm, subjectId))) ?? '0';
  }

  private key(realm: RecentAuthRealm, token: string): string {
    return `recent-auth:${realm}:${sha(token)}`;
  }

  private generationKey(realm: RecentAuthRealm, subjectId: string): string {
    return `recent-auth:gen:${realm}:${subjectId}`;
  }
}
