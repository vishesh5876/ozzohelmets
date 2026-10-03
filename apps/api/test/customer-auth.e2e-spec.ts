import {
  bearer,
  createAdmin,
  createTestApp,
  createTestHelmet,
  login,
  loginCustomer,
  newCustomer,
  resetState,
  TEST_PASSWORD,
  type TestContext,
} from './utils';

describe('Customer authentication — Helmet ID + password (e2e)', () => {
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

  it('stores only peppered Argon2id hashes for password and recovery code', async () => {
    const c = await newCustomer(ctx);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
    expect(user.passwordHash?.startsWith('$argon2id$')).toBe(true);
    expect(user.recoveryCodeHash?.startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(user)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(user)).not.toContain(c.recoveryCode);
    expect(user).toMatchObject({
      email: null,
      mobile: null,
      mobileVerified: false,
      emailVerified: false,
    });
    const audits = JSON.stringify(await ctx.prisma.auditLog.findMany());
    expect(audits).not.toContain(c.recoveryCode);
    expect(audits).not.toContain(TEST_PASSWORD);
  });

  it('logs in with the owned Helmet ID + password (any input format)', async () => {
    const c = await newCustomer(ctx);
    const { res, token } = await loginCustomer(
      ctx,
      c.helmet.helmetCode.toLowerCase().replace(/-/g, ' '),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.customer.id).toBe(c.userId);
    const me = await ctx.http().get('/api/v1/customer/auth/me').set(bearer(token!)).expect(200);
    expect(me.body.data.id).toBe(c.userId);
  });

  it('any helmet owned by the same customer identifies the same account', async () => {
    const c = await newCustomer(ctx);
    const second = await createTestHelmet(ctx, 'SOLD', 'WXYZ6789');
    await ctx
      .http()
      .post('/api/v1/customer/activation/add-helmet')
      .set(bearer(c.token))
      .send({ publicToken: second.publicToken, pin: second.pin })
      .expect(200);
    const viaSecond = await loginCustomer(ctx, second.helmetCode);
    expect(viaSecond.res.status).toBe(200);
    expect(viaSecond.res.body.data.customer.id).toBe(c.userId);
  });

  it('uses one generic error for unknown helmets, unowned helmets and wrong passwords', async () => {
    const c = await newCustomer(ctx);
    const unowned = await createTestHelmet(ctx, 'SOLD');
    const wrongPw = await loginCustomer(ctx, c.helmet.helmetCode, 'not the password');
    const notOwned = await loginCustomer(ctx, unowned.helmetCode, TEST_PASSWORD);
    // A valid-checksum code that doesn't exist.
    const { generateHelmetCode } = await import('../src/security/helmet-identity.generator');
    const missing = await loginCustomer(ctx, generateHelmetCode(), TEST_PASSWORD);
    for (const r of [wrongPw, notOwned, missing]) {
      expect(r.res.status).toBe(401);
      expect(r.res.body.error).toEqual(
        expect.objectContaining({
          code: 'INVALID_CREDENTIALS',
          message: 'The ID or password is incorrect.',
        }),
      );
    }
    const typo = await loginCustomer(ctx, 'HM-AAAA-AAA2', TEST_PASSWORD);
    expect([400, 401]).toContain(typo.res.status);
  });

  it('locks the helmet login temporarily after repeated wrong passwords (escalating, not permanent)', async () => {
    const c = await newCustomer(ctx);
    for (let i = 0; i < 2; i++)
      expect((await loginCustomer(ctx, c.helmet.helmetCode, 'wrong password!')).res.status).toBe(
        401,
      );
    const third = await loginCustomer(ctx, c.helmet.helmetCode, 'wrong password!');
    expect(third.res.status).toBe(401); // 3rd failure starts the lock (threshold 3 in tests)
    const locked = await loginCustomer(ctx, c.helmet.helmetCode, TEST_PASSWORD);
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.error).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      details: { retryAfter: 60 },
    });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'customer.login.locked' } })).toBe(1);
    // Cooldown expires → the real owner gets back in.
    await ctx.redis.del(
      ...(await ctx.redis.keys('helmet-test:lock:customer-login:*:locked')).map((k) =>
        k.replace('helmet-test:', ''),
      ),
    );
    expect((await loginCustomer(ctx, c.helmet.helmetCode, TEST_PASSWORD)).res.status).toBe(200);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const c = await newCustomer(ctx);
    await ctx.http().post('/api/v1/customer/auth/refresh').set('Cookie', c.cookie).expect(403); // CSRF header required
    const r1 = await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', c.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    const rotated = (r1.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(rotated).not.toBe(c.cookie);
    await ctx.prisma.customerRefreshToken.updateMany({
      where: { replacedBy: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });
    const reuse = await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', c.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', rotated)
      .set('X-Requested-With', 'fetch')
      .expect(401);
  });

  it('lists sessions, logs out one, logs out everywhere', async () => {
    const c = await newCustomer(ctx);
    const second = await loginCustomer(ctx, c.helmet.helmetCode);
    const sessions = await ctx
      .http()
      .get('/api/v1/customer/auth/sessions')
      .set(bearer(second.token!))
      .expect(200);
    expect(sessions.body.data).toHaveLength(2);
    await ctx
      .http()
      .post('/api/v1/customer/auth/logout')
      .set('Cookie', c.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', c.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    await ctx
      .http()
      .post('/api/v1/customer/auth/logout-all')
      .set(bearer(second.token!))
      .expect(200);
    expect(
      (await ctx.prisma.customerRefreshToken.findMany({ where: { userId: c.userId } })).every(
        (t) => t.revokedAt,
      ),
    ).toBe(true);
  });

  it('changes the password and revokes other sessions', async () => {
    const c = await newCustomer(ctx);
    const other = await loginCustomer(ctx, c.helmet.helmetCode);
    await ctx
      .http()
      .post('/api/v1/customer/auth/change-password')
      .set(bearer(c.token))
      .send({ currentPassword: 'nope nope nope', newPassword: 'a brand new passphrase' })
      .expect(400);
    await ctx
      .http()
      .post('/api/v1/customer/auth/change-password')
      .set(bearer(c.token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'password' })
      .expect(400);
    await ctx
      .http()
      .post('/api/v1/customer/auth/change-password')
      .set(bearer(c.token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a brand new passphrase' })
      .expect(200);
    await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', other.cookie!)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', c.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    expect((await loginCustomer(ctx, c.helmet.helmetCode, TEST_PASSWORD)).res.status).toBe(401);
    expect(
      (await loginCustomer(ctx, c.helmet.helmetCode, 'a brand new passphrase')).res.status,
    ).toBe(200);
  });

  it('stores optional contact details as unverified and never uses them to sign in', async () => {
    const c = await newCustomer(ctx);
    const res = await ctx
      .http()
      .patch('/api/v1/customer/auth/me')
      .set(bearer(c.token))
      .send({ name: 'Asha', email: 'Asha@Example.com', mobile: '98765 43210' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      name: 'Asha',
      email: 'asha@example.com',
      mobile: '+919876543210',
    });
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).toMatchObject({
      mobileVerified: false,
      emailVerified: false,
    });
    // Another customer may enter the same number: not unique, not an identity.
    const d = await newCustomer(ctx);
    await ctx
      .http()
      .patch('/api/v1/customer/auth/me')
      .set(bearer(d.token))
      .send({ mobile: '+919876543210' })
      .expect(200);
    await ctx
      .http()
      .post('/api/v1/customer/auth/login')
      .send({ helmetCode: '+919876543210', password: TEST_PASSWORD })
      .expect(400);
  });

  it('keeps admin and customer tokens strictly separate', async () => {
    const c = await newCustomer(ctx);
    const admin = await createAdmin(ctx, 'SUPER_ADMIN');
    const adminSession = await login(ctx, admin.email, admin.password);
    await ctx.http().get('/api/v1/admin/auth/me').set(bearer(c.token)).expect(401);
    await ctx.http().get('/api/v1/customer/auth/me').set(bearer(adminSession.token)).expect(401);
  });

  it('blocks suspended customers immediately', async () => {
    const c = await newCustomer(ctx);
    await ctx.prisma.user.update({ where: { id: c.userId }, data: { status: 'SUSPENDED' } });
    expect(
      (await ctx.http().get('/api/v1/customer/auth/me').set(bearer(c.token)).expect(401)).body.error
        .code,
    ).toBe('ACCOUNT_DISABLED');
    expect((await loginCustomer(ctx, c.helmet.helmetCode)).res.status).toBe(401);
  });
});
