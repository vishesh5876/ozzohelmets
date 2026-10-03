import { randomUUID } from 'node:crypto';
import {
  hashRefreshToken,
  type RefreshTokenRecord,
  RefreshTokenRotator,
  type RefreshTokenStore,
  ROTATION_RACE_GRACE_MS,
} from './refresh-token-rotator';

class MemoryStore implements RefreshTokenStore {
  rows: (RefreshTokenRecord & { tokenHash: string })[] = [];
  constructor(private readonly now: () => number) {}
  async findByHash(tokenHash: string) {
    return this.rows.find((r) => r.tokenHash === tokenHash) ?? null;
  }
  async create(d: { subjectId: string; familyId: string; tokenHash: string; expiresAt: Date }) {
    const id = randomUUID();
    this.rows.push({
      id,
      subjectId: d.subjectId,
      familyId: d.familyId,
      tokenHash: d.tokenHash,
      expiresAt: d.expiresAt,
      revokedAt: null,
      replacedBy: null,
    });
    return { id };
  }
  async claim(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.revokedAt) return false;
    row.revokedAt = new Date(this.now());
    return true;
  }
  async setReplacedBy(id: string, replacementId: string) {
    this.rows.find((r) => r.id === id)!.replacedBy = replacementId;
  }
  async revokeFamily(familyId: string) {
    this.rows
      .filter((r) => r.familyId === familyId && !r.revokedAt)
      .forEach((r) => (r.revokedAt = new Date(this.now())));
  }
  async revokeAllForSubject(subjectId: string) {
    this.rows
      .filter((r) => r.subjectId === subjectId && !r.revokedAt)
      .forEach((r) => (r.revokedAt = new Date(this.now())));
  }
}

const meta = { ipHash: null, userAgent: 'jest' };
const active = async () => true;

function setup() {
  let now = 1_700_000_000_000;
  const store = new MemoryStore(() => now);
  const rotator = new RefreshTokenRotator(
    store,
    () => 7 * 86_400_000,
    () => now,
  );
  return { store, rotator, advance: (ms: number) => (now += ms) };
}

describe('RefreshTokenRotator', () => {
  it('stores only SHA-256 hashes', async () => {
    const { store, rotator } = setup();
    const issued = await rotator.issue('user-1', meta);
    expect(store.rows[0]!.tokenHash).toBe(hashRefreshToken(issued.token));
    expect(JSON.stringify(store.rows)).not.toContain(issued.token);
  });

  it('rotates: new token in the same family, old token revoked', async () => {
    const { store, rotator } = setup();
    const first = await rotator.issue('user-1', meta);
    const result = await rotator.rotate(first.token, meta, active);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refresh.token).not.toBe(first.token);
    expect(result.refresh.familyId).toBe(first.familyId);
    expect(store.rows[0]!.revokedAt).not.toBeNull();
    expect(store.rows[0]!.replacedBy).toBe(result.refresh.id);
  });

  it('treats a replay inside the race window as merely invalid', async () => {
    const { rotator } = setup();
    const first = await rotator.issue('user-1', meta);
    const second = await rotator.rotate(first.token, meta, active);
    expect(await rotator.rotate(first.token, meta, active)).toEqual({
      ok: false,
      reason: 'INVALID',
    });
    if (second.ok) expect((await rotator.rotate(second.refresh.token, meta, active)).ok).toBe(true);
  });

  it('detects reuse after the race window and revokes the whole family', async () => {
    const { store, rotator, advance } = setup();
    const first = await rotator.issue('user-1', meta);
    const second = await rotator.rotate(first.token, meta, active);
    advance(ROTATION_RACE_GRACE_MS + 1);
    const reuse = await rotator.rotate(first.token, meta, active);
    expect(reuse).toMatchObject({
      ok: false,
      reason: 'REUSED',
      subjectId: 'user-1',
      familyId: first.familyId,
    });
    expect(store.rows.every((r) => r.revokedAt !== null)).toBe(true);
    if (second.ok)
      expect((await rotator.rotate(second.refresh.token, meta, active)).ok).toBe(false);
  });

  it('rejects expired, unknown and oversized tokens', async () => {
    const { rotator, advance } = setup();
    const first = await rotator.issue('user-1', meta);
    expect(await rotator.rotate('nope', meta, active)).toEqual({ ok: false, reason: 'INVALID' });
    expect(await rotator.rotate('x'.repeat(200), meta, active)).toEqual({
      ok: false,
      reason: 'INVALID',
    });
    advance(8 * 86_400_000);
    expect(await rotator.rotate(first.token, meta, active)).toEqual({
      ok: false,
      reason: 'INVALID',
    });
  });

  it('revokes the family when the subject is no longer active', async () => {
    const { store, rotator } = setup();
    const first = await rotator.issue('user-1', meta);
    expect(await rotator.rotate(first.token, meta, async () => false)).toMatchObject({
      ok: false,
      reason: 'INACTIVE',
    });
    expect(store.rows[0]!.revokedAt).not.toBeNull();
  });

  it('logout revokes one family; revoke-all revokes every session', async () => {
    const { rotator } = setup();
    const a = await rotator.issue('user-1', meta);
    const b = await rotator.issue('user-1', meta);
    await rotator.revoke(a.token);
    expect((await rotator.rotate(a.token, meta, active)).ok).toBe(false);
    expect(await rotator.familyOf(b.token)).toBe(b.familyId);
    await rotator.revokeAllForSubject('user-1');
    expect((await rotator.rotate(b.token, meta, active)).ok).toBe(false);
  });
});
