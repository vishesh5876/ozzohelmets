import {
  bearer,
  createTestApp,
  loginCustomer,
  newCustomer,
  resetState,
  TEST_PASSWORD,
  type TestContext,
} from './utils';

describe('Account recovery — Helmet ID + offline recovery code (e2e)', () => {
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

  const recover = (helmetCode: string, recoveryCode: string) =>
    ctx.http().post('/api/v1/customer/auth/recover').send({ helmetCode, recoveryCode });
  const reset = (resetToken: string, newPassword: string) =>
    ctx.http().post('/api/v1/customer/auth/reset-password').send({ resetToken, newPassword });

  it('resets the password, revokes all sessions and rotates the recovery code', async () => {
    const c = await newCustomer(ctx);
    expect(c.recoveryCode).toMatch(/^RK-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const other = await loginCustomer(ctx, c.helmet.helmetCode);

    const r = await recover(
      c.helmet.helmetCode,
      c.recoveryCode.toLowerCase().replace(/-/g, ''),
    ).expect(200);
    expect(r.body.data.expiresIn).toBe(600);
    const done = await reset(r.body.data.resetToken, 'my new long passphrase').expect(200);
    expect(done.body.data.recoveryCode).toMatch(/^RK-/);
    expect(done.body.data.recoveryCode).not.toBe(c.recoveryCode);
    expect(done.body.data.accessToken).toBeTruthy();

    // All previous sessions revoked.
    for (const cookie of [c.cookie, other.cookie!])
      await ctx
        .http()
        .post('/api/v1/customer/auth/refresh')
        .set('Cookie', cookie)
        .set('X-Requested-With', 'fetch')
        .expect(401);
    // Old password fails, new password works.
    expect((await loginCustomer(ctx, c.helmet.helmetCode, TEST_PASSWORD)).res.status).toBe(401);
    expect(
      (await loginCustomer(ctx, c.helmet.helmetCode, 'my new long passphrase')).res.status,
    ).toBe(200);
    // Old recovery code is dead; the new one works.
    expect((await recover(c.helmet.helmetCode, c.recoveryCode)).status).toBe(401);
    await recover(c.helmet.helmetCode, done.body.data.recoveryCode).expect(200);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'customer.password.reset', userId: c.userId },
      }),
    ).toBe(1);
  });

  it('reset tokens are single use and expire', async () => {
    const c = await newCustomer(ctx);
    const r = await recover(c.helmet.helmetCode, c.recoveryCode).expect(200);
    await reset(r.body.data.resetToken, 'first new passphrase').expect(200);
    expect(
      (await reset(r.body.data.resetToken, 'second new passphrase').expect(400)).body.error.code,
    ).toBe('RESET_TOKEN_INVALID');
    expect((await reset('x'.repeat(43), 'third new passphrase').expect(400)).body.error.code).toBe(
      'RESET_TOKEN_INVALID',
    );
  });

  it('two reset tokens from the same recovery code cannot both be used', async () => {
    const c = await newCustomer(ctx);
    const a = await recover(c.helmet.helmetCode, c.recoveryCode).expect(200);
    const b = await recover(c.helmet.helmetCode, c.recoveryCode).expect(200);
    await reset(a.body.data.resetToken, 'winner passphrase one').expect(200);
    expect(
      (await reset(b.body.data.resetToken, 'loser passphrase two').expect(400)).body.error.code,
    ).toBe('RESET_TOKEN_INVALID');
  });

  it('rejects weak new passwords without consuming the reset', async () => {
    const c = await newCustomer(ctx);
    const r = await recover(c.helmet.helmetCode, c.recoveryCode).expect(200);
    expect((await reset(r.body.data.resetToken, '123').expect(400)).body.error.code).toBe(
      'WEAK_PASSWORD',
    );
  });

  it('is heavily rate limited and uses generic errors', async () => {
    const c = await newCustomer(ctx);
    for (let i = 0; i < 3; i++) {
      const res = await recover(c.helmet.helmetCode, 'RK-2222-2222-2222').expect(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'The ID or recovery code is incorrect.',
      });
    }
    const locked = await recover(c.helmet.helmetCode, c.recoveryCode).expect(429);
    expect(locked.body.error).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      details: { retryAfter: 900 },
    });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'customer.recovery.locked' } })).toBe(
      1,
    );
    expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain('RK-2222');
  });

  it('a signed-in customer can rotate the recovery code with their password', async () => {
    const c = await newCustomer(ctx);
    await ctx
      .http()
      .post('/api/v1/customer/auth/recovery-code')
      .set(bearer(c.token))
      .send({ password: 'wrong wrong wrong' })
      .expect(400);
    const res = await ctx
      .http()
      .post('/api/v1/customer/auth/recovery-code')
      .set(bearer(c.token))
      .send({ password: TEST_PASSWORD })
      .expect(200);
    expect((await recover(c.helmet.helmetCode, c.recoveryCode)).status).toBe(401);
    await recover(c.helmet.helmetCode, res.body.data.recoveryCode).expect(200);
  });
});
