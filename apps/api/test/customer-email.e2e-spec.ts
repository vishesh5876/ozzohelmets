import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  bearer,
  createTestApp,
  createTestHelmet,
  newCustomer,
  registerCustomer,
  resetState,
  startTransfer,
  TEST_PASSWORD,
  type TestContext,
  uniqueEmail,
} from './utils';

/**
 * Email binding at first activation, email sign-in, email change and recovery without mailbox
 * access. The activation PIN stays the only proof of possession; email never is.
 */
describe('Customer account email (e2e)', () => {
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

  const register = (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/customer/activation/register').send(body);
  const login = (identifier: string, password = TEST_PASSWORD) =>
    ctx.http().post('/api/v1/customer/auth/login').send({ identifier, password });
  const changeEmail = (token: string, body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/customer/auth/email').set(bearer(token)).send(body);

  const expectPinUnconsumed = async (helmetId: string) => {
    const row = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: helmetId } });
    expect(row).toMatchObject({ status: 'SOLD', activationPinUsed: false, activatedAt: null });
    expect(await ctx.prisma.helmetActivationSecret.count({ where: { helmetId } })).toBe(1);
    expect(await ctx.prisma.helmetOwnership.count({ where: { helmetId } })).toBe(0);
  };

  describe('first activation', () => {
    it('creates the account with the email (canonicalised, unverified) in the same transaction', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      const res = await register({
        publicToken: h.publicToken,
        pin: h.pin,
        email: '  Asha.Rider+helmet@Example.COM ',
        password: TEST_PASSWORD,
      }).expect(200);
      expect(res.body.data.customer).toMatchObject({
        email: 'Asha.Rider+helmet@example.com',
        emailVerified: false,
      });
      expect(res.body.data.recoveryCode).toMatch(/^RK-/);
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: res.body.data.customer.id },
      });
      // Dots and plus tags are kept: they are distinct mailboxes for many providers.
      expect(user).toMatchObject({
        email: 'Asha.Rider+helmet@example.com',
        emailNormalized: 'asha.rider+helmet@example.com',
        emailVerified: false,
      });
      const ownership = await ctx.prisma.helmetOwnership.findFirstOrThrow({
        where: { helmetId: h.id },
      });
      expect(ownership).toMatchObject({ userId: user.id, status: 'ACTIVE' });
      // Addresses are never written to the audit trail.
      expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toMatch(/asha\.rider/i);
    });

    it('rejects a malformed email or an email reused as password without consuming the PIN', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      const bad = await register({
        publicToken: h.publicToken,
        pin: h.pin,
        email: 'not-an-email',
        password: TEST_PASSWORD,
      }).expect(400);
      expect(bad.body.error.code).toBe('INVALID_EMAIL');
      await register({
        publicToken: h.publicToken,
        pin: h.pin,
        password: TEST_PASSWORD,
      }).expect(400);
      const same = await register({
        publicToken: h.publicToken,
        pin: h.pin,
        email: 'rider.pass@example.com',
        password: 'Rider.Pass@example.com',
      }).expect(400);
      expect(same.body.error.code).toBe('WEAK_PASSWORD');
      await expectPinUnconsumed(h.id);
    });

    it('enforces normalized email uniqueness; a duplicate does not consume the PIN', async () => {
      const first = await newCustomer(ctx);
      const h = await createTestHelmet(ctx, 'SOLD');
      const usersBefore = await ctx.prisma.user.count();
      const dup = await register({
        publicToken: h.publicToken,
        pin: h.pin,
        email: first.email.toUpperCase(),
        password: 'another rider passphrase',
      }).expect(409);
      expect(dup.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
      expect(await ctx.prisma.user.count()).toBe(usersBefore);
      await expectPinUnconsumed(h.id);
      // A wrong PIN is still checked first — an email conflict is only revealed to PIN holders.
      const wrongPin = await register({
        publicToken: h.publicToken,
        pin: 'ZZZZ9999',
        email: first.email,
        password: 'another rider passphrase',
      }).expect(400);
      expect(wrongPin.body.error.code).toBe('INVALID_ACTIVATION_PIN');
      // The same PIN still works with a free address.
      await register({
        publicToken: h.publicToken,
        pin: h.pin,
        email: uniqueEmail(),
        password: 'another rider passphrase',
      }).expect(200);
    });

    it('two simultaneous activations with the same email on different helmets: one wins, nothing partial', async () => {
      const email = uniqueEmail('race');
      const [h1, h2] = [await createTestHelmet(ctx, 'SOLD'), await createTestHelmet(ctx, 'SOLD')];
      const results = await Promise.all(
        [h1, h2].map((h) =>
          register({ publicToken: h.publicToken, pin: h.pin, email, password: TEST_PASSWORD }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
        'EMAIL_ALREADY_REGISTERED',
      );
      expect(await ctx.prisma.user.count({ where: { emailNormalized: email } })).toBe(1);
      const loser = results[0]!.status === 409 ? h1 : h2;
      await expectPinUnconsumed(loser.id);
    });
  });

  describe('sign-in identifiers', () => {
    it('email + password (case/whitespace-insensitive), Customer ID and Helmet ID all work', async () => {
      const c = await newCustomer(ctx);
      const byEmail = await login(`  ${c.email.toUpperCase()} `).expect(200);
      expect(byEmail.body.data.customer.id).toBe(c.userId);
      const profile = byEmail.body.data.customer;
      await login(profile.customerId).expect(200);
      await login(c.helmet.helmetCode).expect(200);
    });

    it('unknown email and wrong password are indistinguishable', async () => {
      const c = await newCustomer(ctx);
      const unknown = await login('nobody@example.com').expect(401);
      const wrong = await login(c.email, 'not the password at all').expect(401);
      expect({ ...unknown.body.error, requestId: 0 }).toEqual({
        ...wrong.body.error,
        requestId: 0,
      });
      expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('an account with zero helmets can still sign in with its email', async () => {
      const a = await newCustomer(ctx);
      const b = await newCustomer(ctx, 'the new owners own passphrase');
      const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
      await ctx
        .http()
        .post('/api/v1/customer/transfers/claim')
        .set(bearer(b.token))
        .send({ helmetCode: a.helmet.helmetCode, transferCode })
        .expect(200);
      await login(a.helmet.helmetCode).expect(401);
      const res = await login(a.email).expect(200);
      expect(res.body.data.customer.id).toBe(a.userId);
      const list = await ctx
        .http()
        .get('/api/v1/customer/helmets')
        .set(bearer(res.body.data.accessToken))
        .expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('a second helmet joins the existing account with just its PIN (no email/password)', async () => {
      const c = await newCustomer(ctx);
      const second = await createTestHelmet(ctx, 'IN_INVENTORY');
      const usersBefore = await ctx.prisma.user.count();
      await ctx
        .http()
        .post('/api/v1/customer/activation/add-helmet')
        .set(bearer(c.token))
        .send({ helmetCode: second.helmetCode, pin: second.pin })
        .expect(200);
      expect(await ctx.prisma.user.count()).toBe(usersBefore);
      const list = await ctx
        .http()
        .get('/api/v1/customer/helmets')
        .set(bearer(c.token))
        .expect(200);
      expect(list.body.data.map((h: { id: string }) => h.id).sort()).toEqual(
        [c.helmet.id, second.id].sort(),
      );
    });
  });

  describe('recovery without mailbox access', () => {
    it('email + recovery code → new password, sessions revoked, code rotated and shown once', async () => {
      const c = await newCustomer(ctx);
      const rec = await ctx
        .http()
        .post('/api/v1/customer/auth/recover')
        .send({ identifier: c.email, recoveryCode: c.recoveryCode })
        .expect(200);
      const reset = await ctx
        .http()
        .post('/api/v1/customer/auth/reset-password')
        .send({ resetToken: rec.body.data.resetToken, newPassword: 'a brand new passphrase' })
        .expect(200);
      expect(reset.body.data.recoveryCode).toMatch(/^RK-/);
      expect(reset.body.data.recoveryCode).not.toBe(c.recoveryCode);
      await ctx
        .http()
        .post('/api/v1/customer/auth/refresh')
        .set('Cookie', c.cookie)
        .set('X-Requested-With', 'fetch')
        .expect(401);
      await login(c.email).expect(401);
      await login(c.email, 'a brand new passphrase').expect(200);
      // The old recovery code is dead.
      await ctx
        .http()
        .post('/api/v1/customer/auth/recover')
        .send({ identifier: c.email, recoveryCode: c.recoveryCode })
        .expect(401);
    });
  });

  describe('email change', () => {
    it('requires the current password and a matching confirmation', async () => {
      const c = await newCustomer(ctx);
      const next = uniqueEmail('next');
      const noPassword = await changeEmail(c.token, { newEmail: next, confirmEmail: next });
      expect(noPassword.status).toBe(400);
      const wrong = await changeEmail(c.token, {
        currentPassword: 'definitely wrong',
        newEmail: next,
        confirmEmail: next,
      }).expect(400);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      const mismatch = await changeEmail(c.token, {
        currentPassword: TEST_PASSWORD,
        newEmail: next,
        confirmEmail: uniqueEmail('typo'),
      }).expect(400);
      expect(mismatch.body.error.code).toBe('VALIDATION_ERROR');
      await ctx.http().post('/api/v1/customer/auth/email').send({}).expect(401);
      await login(c.email).expect(200);
    });

    it('rejects an address used by another account (normalized)', async () => {
      const a = await newCustomer(ctx);
      const b = await newCustomer(ctx);
      const res = await changeEmail(b.token, {
        currentPassword: TEST_PASSWORD,
        newEmail: a.email.toUpperCase(),
        confirmEmail: a.email,
      }).expect(409);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
      await login(b.email).expect(200);
    });

    it('updates the sign-in email, revokes other sessions, keeps this one, audits without addresses', async () => {
      const c = await newCustomer(ctx);
      const other = await login(c.email).expect(200);
      const otherCookie = (other.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
      const next = uniqueEmail('Changed');
      const res = await changeEmail(c.token, {
        currentPassword: TEST_PASSWORD,
        newEmail: next,
        confirmEmail: next.toLowerCase(),
      }).expect(200);
      expect(res.body.data).toMatchObject({ email: next, emailVerified: false });
      await login(c.email).expect(401);
      await login(next).expect(200);
      await ctx
        .http()
        .post('/api/v1/customer/auth/refresh')
        .set('Cookie', otherCookie)
        .set('X-Requested-With', 'fetch')
        .expect(401);
      await ctx
        .http()
        .post('/api/v1/customer/auth/refresh')
        .set('Cookie', c.cookie)
        .set('X-Requested-With', 'fetch')
        .expect(200);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'customer.email.changed', userId: c.userId },
      });
      expect(JSON.stringify(audit)).not.toContain(next.toLowerCase());
      expect(JSON.stringify(audit)).not.toContain(c.email);
    });

    it('lets a legacy account without an email add one', async () => {
      const c = await newCustomer(ctx);
      await ctx.prisma.user.update({
        where: { id: c.userId },
        data: { email: null, emailNormalized: null },
      });
      const next = uniqueEmail('legacy');
      await changeEmail(c.token, {
        currentPassword: TEST_PASSWORD,
        newEmail: next,
        confirmEmail: next,
      }).expect(200);
      await login(next).expect(200);
    });
  });

  it('a deleted account releases its email', async () => {
    const a = await newCustomer(ctx);
    await ctx.prisma.user.update({ where: { id: a.userId }, data: { status: 'DELETED' } });
    const h = await createTestHelmet(ctx, 'SOLD');
    await registerCustomer(ctx, h, TEST_PASSWORD, undefined, a.email);
  });

  it('exposes no OTP and no dealer/distributor/partner/inventory endpoints', async () => {
    const doc = SwaggerModule.createDocument(ctx.app, new DocumentBuilder().build());
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBeGreaterThan(20);
    expect(
      paths.filter((p) =>
        /otp|sms|verify-email|partner|dealer|distributor|organization|inventory|stock|manifest|retail/i.test(
          p,
        ),
      ),
    ).toEqual([]);
    for (const p of [
      '/api/v1/customer/auth/otp/request',
      '/api/v1/partner/auth/login',
      '/api/v1/admin/organizations',
    ])
      await ctx.http().post(p).send({}).expect(404);
  });
});
