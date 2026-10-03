import { createAdmin, createTestApp, login, resetState, type TestContext } from './utils';

describe('Admin authentication (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('logs in, returns profile, and sets a hardened refresh cookie', async () => {
    const admin = await createAdmin(ctx, 'SUPER_ADMIN');
    const res = await ctx
      .http()
      .post('/api/v1/admin/auth/login')
      .send({ email: admin.email.toUpperCase(), password: admin.password })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.admin).toMatchObject({ email: admin.email, role: 'SUPER_ADMIN' });
    expect(res.body.data.admin.passwordHash).toBeUndefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/helmet_admin_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/admin\/auth/);

    const me = await ctx
      .http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);
    expect(me.body.data.permissions).toContain('export:manufacturing');
  });

  it('rejects bad credentials with a generic error and locks out after repeated failures', async () => {
    const admin = await createAdmin(ctx, 'ADMIN');
    for (let i = 0; i < 3; i++) {
      const res = await ctx
        .http()
        .post('/api/v1/admin/auth/login')
        .send({ email: admin.email, password: 'wrong-password' })
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await ctx
      .http()
      .post('/api/v1/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    const unknown = await ctx
      .http()
      .post('/api/v1/admin/auth/login')
      .send({ email: 'nobody@test.local', password: 'x' })
      .expect(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');

    const failures = await ctx.prisma.auditLog.count({ where: { action: 'admin.login.failed' } });
    expect(failures).toBe(4);
  });

  it('validates request bodies', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/admin/auth/login')
      .send({ email: 'not-an-email', password: 'x', extra: 1 })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing, malformed and disabled-account tokens', async () => {
    await ctx.http().get('/api/v1/admin/auth/me').expect(401);
    await ctx
      .http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
    const admin = await createAdmin(ctx, 'SUPPORT');
    const { token } = await login(ctx, admin.email, admin.password);
    await ctx.prisma.adminUser.update({ where: { id: admin.id }, data: { status: 'DISABLED' } });
    const res = await ctx
      .http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('rotates refresh tokens and requires the CSRF header', async () => {
    const admin = await createAdmin(ctx, 'ADMIN');
    const { cookie } = await login(ctx, admin.email, admin.password);

    await ctx.http().post('/api/v1/admin/auth/refresh').set('Cookie', cookie).expect(403);

    const res = await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    const rotated = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(rotated).not.toEqual(cookie);
    expect(res.body.data.accessToken).toBeTruthy();

    // The old token is now revoked (within the race grace window it is simply invalid).
    const replay = await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', rotated)
      .set('X-Requested-With', 'fetch')
      .expect(200);
  });

  it('detects refresh-token reuse and revokes the whole family', async () => {
    const admin = await createAdmin(ctx, 'ADMIN');
    const { cookie } = await login(ctx, admin.email, admin.password);
    const res = await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    const rotated = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    // Simulate an attacker replaying the stolen original token long after rotation.
    await ctx.prisma.adminRefreshToken.updateMany({
      where: { replacedBy: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });
    const reuse = await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The legitimate (rotated) token was revoked with the family.
    await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', rotated)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'admin.refresh.reuse_detected' } }),
    ).toBe(1);
  });

  it('logout revokes the session', async () => {
    const admin = await createAdmin(ctx, 'ADMIN');
    const { cookie } = await login(ctx, admin.email, admin.password);
    await ctx
      .http()
      .post('/api/v1/admin/auth/logout')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    const tokens = await ctx.prisma.adminRefreshToken.findMany({ where: { adminId: admin.id } });
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
    // Raw tokens are never stored.
    expect(tokens.every((t) => /^[0-9a-f]{64}$/.test(t.tokenHash))).toBe(true);
  });
});
