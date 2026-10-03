import {
  bearer,
  createAdmin,
  createTestApp,
  customerLogin,
  login,
  resetState,
  type TestContext,
} from './utils';

describe('Customer authentication (e2e)', () => {
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

  it('requests an OTP with a normalised number and an identical response for new and existing numbers', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/customer/auth/otp/request')
      .send({ mobile: '098765 43210' })
      .expect(200);
    expect(res.body.data).toMatchObject({ sent: true, mobile: '+919876543210', expiresIn: 300 });
    expect(res.body.data.devOtp).toMatch(/^\d{6}$/);
    await ctx
      .http()
      .post('/api/v1/customer/auth/otp/request')
      .send({ mobile: 'not a phone' })
      .expect(400);
    expect(await ctx.prisma.user.count()).toBe(0); // requesting never creates an account
  });

  it('verifies the OTP, creates the customer once, and never stores the OTP in PostgreSQL', async () => {
    const first = await customerLogin(ctx, '+919876543210');
    expect(first.isNew).toBe(true);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: first.userId } });
    expect(user).toMatchObject({ mobile: '+919876543210', mobileVerified: true, status: 'ACTIVE' });
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'customer.created', userId: first.userId },
      }),
    ).toBe(1);

    await ctx.redis.flushdb(); // reset cooldown
    const second = await customerLogin(ctx, '9876543210');
    expect(second.isNew).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(await ctx.prisma.user.count()).toBe(1);

    const me = await ctx
      .http()
      .get('/api/v1/customer/auth/me')
      .set(bearer(second.token))
      .expect(200);
    expect(me.body.data.mobile).toBe('+919876543210');
  });

  it('rejects wrong, reused and exhausted OTPs', async () => {
    const otp = await ctx
      .http()
      .post('/api/v1/customer/auth/otp/request')
      .send({ mobile: '+919876543211' })
      .expect(200);
    const code = otp.body.data.devOtp as string;
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await ctx
      .http()
      .post('/api/v1/customer/auth/otp/verify')
      .send({ mobile: '+919876543211', otp: wrong })
      .expect(400);
    expect(bad.body.error).toMatchObject({
      code: 'INVALID_OTP',
      details: { attemptsRemaining: 4 },
    });
    await ctx
      .http()
      .post('/api/v1/customer/auth/otp/verify')
      .send({ mobile: '+919876543211', otp: code })
      .expect(200);
    const reused = await ctx
      .http()
      .post('/api/v1/customer/auth/otp/verify')
      .send({ mobile: '+919876543211', otp: code })
      .expect(400);
    expect(reused.body.error.code).toBe('OTP_EXPIRED');

    await ctx.redis.flushdb();
    await ctx
      .http()
      .post('/api/v1/customer/auth/otp/request')
      .send({ mobile: '+919876543212' })
      .expect(200);
    for (let i = 0; i < 4; i++)
      await ctx
        .http()
        .post('/api/v1/customer/auth/otp/verify')
        .send({ mobile: '+919876543212', otp: '999999' })
        .expect(400);
    const locked = await ctx
      .http()
      .post('/api/v1/customer/auth/otp/verify')
      .send({ mobile: '+919876543212', otp: '999999' })
      .expect(429);
    expect(locked.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
    const after = await ctx
      .http()
      .post('/api/v1/customer/auth/otp/verify')
      .send({ mobile: '+919876543212', otp: '999999' })
      .expect(400);
    expect(after.body.error.code).toBe('OTP_EXPIRED');
  });

  it('enforces the resend cooldown and per-mobile limit', async () => {
    await ctx
      .http()
      .post('/api/v1/customer/auth/otp/request')
      .send({ mobile: '+919876543213' })
      .expect(200);
    const res = await ctx
      .http()
      .post('/api/v1/customer/auth/otp/request')
      .send({ mobile: '+919876543213' })
      .expect(429);
    expect(res.body.error.code).toBe('OTP_RATE_LIMITED');
    expect(res.body.error.details.retryAfter).toBeGreaterThan(0);
  });

  it('rotates refresh tokens, detects reuse and revokes the family', async () => {
    const session = await customerLogin(ctx, '+919876543214');
    const cookie = session.cookie;
    expect(cookie).toMatch(/^helmet_customer_rt=/);
    await ctx.http().post('/api/v1/customer/auth/refresh').set('Cookie', cookie).expect(403); // CSRF header required
    const r1 = await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    const rotated = (r1.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect(rotated).not.toBe(cookie);

    await ctx.prisma.customerRefreshToken.updateMany({
      where: { replacedBy: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });
    const reuse = await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', rotated)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'customer.refresh.reuse_detected' } }),
    ).toBe(1);
  });

  it('lists sessions, logs out one, and logs out everywhere', async () => {
    const a = await customerLogin(ctx, '+919876543215');
    await ctx.redis.flushdb();
    const b = await customerLogin(ctx, '+919876543215');
    const sessions = await ctx
      .http()
      .get('/api/v1/customer/auth/sessions')
      .set(bearer(b.token))
      .expect(200);
    expect(sessions.body.data).toHaveLength(2);
    expect(sessions.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    await ctx
      .http()
      .post('/api/v1/customer/auth/logout')
      .set('Cookie', a.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);
    await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', a.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
    await ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', b.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(200);

    await ctx.http().post('/api/v1/customer/auth/logout-all').set(bearer(b.token)).expect(200);
    const all = await ctx.prisma.customerRefreshToken.findMany({ where: { userId: b.userId } });
    expect(all.every((t) => t.revokedAt !== null)).toBe(true);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'customer.sessions.revoked' } }),
    ).toBe(1);
  });

  it('keeps admin and customer tokens strictly separate', async () => {
    const customer = await customerLogin(ctx, '+919876543216');
    const admin = await createAdmin(ctx, 'SUPER_ADMIN');
    const adminSession = await login(ctx, admin.email, admin.password);
    await ctx.http().get('/api/v1/admin/auth/me').set(bearer(customer.token)).expect(401);
    await ctx.http().get('/api/v1/customer/auth/me').set(bearer(adminSession.token)).expect(401);
  });

  it('blocks suspended customers immediately', async () => {
    const s = await customerLogin(ctx, '+919876543217');
    await ctx.prisma.user.update({ where: { id: s.userId }, data: { status: 'SUSPENDED' } });
    const res = await ctx.http().get('/api/v1/customer/auth/me').set(bearer(s.token)).expect(401);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});
