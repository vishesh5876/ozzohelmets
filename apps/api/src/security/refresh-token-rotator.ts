import { createHash, randomUUID } from 'node:crypto';
import type { RequestMeta } from '../common/utils/request-context';
import { opaqueToken } from './secure-random';

/** Window in which presenting an already-rotated token is treated as a benign race (two tabs). */
export const ROTATION_RACE_GRACE_MS = 15_000;

export interface RefreshTokenRecord {
  id: string;
  subjectId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

/** Persistence port; admin and customer tokens live in separate tables. */
export interface RefreshTokenStore {
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  create(data: {
    subjectId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    ipHash: string | null;
  }): Promise<{ id: string }>;
  /** Atomically revokes the token if still active; returns false if another request won. */
  claim(id: string): Promise<boolean>;
  setReplacedBy(id: string, replacementId: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllForSubject(subjectId: string): Promise<void>;
}

export interface IssuedRefreshToken {
  id: string;
  token: string;
  expiresAt: Date;
  familyId: string;
}

export type RotationResult =
  | { ok: true; subjectId: string; refresh: IssuedRefreshToken }
  | { ok: false; reason: 'INVALID' }
  | { ok: false; reason: 'REUSED' | 'INACTIVE'; subjectId: string; familyId: string };

export const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Opaque refresh tokens: 256-bit random, stored as SHA-256, rotated on every use. Tokens of one
 * login form a family; presenting a token that was already rotated (outside the race window)
 * means it was copied, so the whole family is revoked.
 */
export class RefreshTokenRotator {
  constructor(
    private readonly store: RefreshTokenStore,
    private readonly ttlMs: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(
    subjectId: string,
    meta: RequestMeta,
    familyId: string = randomUUID(),
  ): Promise<IssuedRefreshToken> {
    const token = opaqueToken(32);
    const expiresAt = new Date(this.now() + this.ttlMs());
    const { id } = await this.store.create({
      subjectId,
      familyId,
      tokenHash: hashRefreshToken(token),
      expiresAt,
      userAgent: meta.userAgent,
      ipHash: meta.ipHash,
    });
    return { id, token, expiresAt, familyId };
  }

  async rotate(
    rawToken: string,
    meta: RequestMeta,
    isSubjectActive: (subjectId: string) => Promise<boolean>,
  ): Promise<RotationResult> {
    if (!rawToken || rawToken.length > 128) return { ok: false, reason: 'INVALID' };
    const existing = await this.store.findByHash(hashRefreshToken(rawToken));
    if (!existing) return { ok: false, reason: 'INVALID' };

    if (existing.revokedAt) {
      const sinceRevocation = this.now() - existing.revokedAt.getTime();
      if (existing.replacedBy && sinceRevocation > ROTATION_RACE_GRACE_MS) {
        await this.store.revokeFamily(existing.familyId);
        return {
          ok: false,
          reason: 'REUSED',
          subjectId: existing.subjectId,
          familyId: existing.familyId,
        };
      }
      return { ok: false, reason: 'INVALID' };
    }
    if (existing.expiresAt.getTime() <= this.now()) return { ok: false, reason: 'INVALID' };
    if (!(await isSubjectActive(existing.subjectId))) {
      await this.store.revokeFamily(existing.familyId);
      return {
        ok: false,
        reason: 'INACTIVE',
        subjectId: existing.subjectId,
        familyId: existing.familyId,
      };
    }
    if (!(await this.store.claim(existing.id))) return { ok: false, reason: 'INVALID' };

    const next = await this.issue(existing.subjectId, meta, existing.familyId);
    await this.store.setReplacedBy(existing.id, next.id);
    return { ok: true, subjectId: existing.subjectId, refresh: next };
  }

  /** Revokes the presented token's family (logout). Returns the subject, or null if unknown. */
  async revoke(rawToken: string): Promise<{ subjectId: string; familyId: string } | null> {
    if (!rawToken || rawToken.length > 128) return null;
    const existing = await this.store.findByHash(hashRefreshToken(rawToken));
    if (!existing) return null;
    await this.store.revokeFamily(existing.familyId);
    return { subjectId: existing.subjectId, familyId: existing.familyId };
  }

  /** Family id of a still-valid token, without rotating it (used to mark the current session). */
  async familyOf(rawToken: string | undefined): Promise<string | null> {
    if (!rawToken || rawToken.length > 128) return null;
    const existing = await this.store.findByHash(hashRefreshToken(rawToken));
    return existing && !existing.revokedAt ? existing.familyId : null;
  }

  revokeFamily(familyId: string): Promise<void> {
    return this.store.revokeFamily(familyId);
  }

  revokeAllForSubject(subjectId: string): Promise<void> {
    return this.store.revokeAllForSubject(subjectId);
  }
}
