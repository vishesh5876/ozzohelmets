import { generateSafetyCode } from '../src/security/helmet-identity.generator';
import {
  bearer,
  createTestApp,
  createTestHelmet,
  loginCustomer,
  newCustomer,
  registerCustomer,
  resetState,
  TEST_PASSWORD,
  type TestContext,
  uniqueEmail,
  TEST_MOBILE,
} from './utils';

describe('Safety ID activation — PIN as proof of possession (e2e)', () => {
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

  const validate = (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/customer/activation/validate').send(body);
  const register = (body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/api/v1/customer/activation/register')
      .send({ email: uniqueEmail(), mobile: TEST_MOBILE, ...body });
  const addHelmet = (token: string, body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/customer/activation/add-safety-id').set(bearer(token)).send(body);
  const safetyRow = (id: string) => ctx.prisma.safetyId.findUniqueOrThrow({ where: { id } });

  it('requires a valid mobile number for the new account and stores it in E.164', async () => {
    const h = await createTestHelmet(ctx, 'SOLD');
    const body = { publicToken: h.publicToken, pin: h.pin, password: TEST_PASSWORD };
    // Missing or invalid: rejected before the PIN is consumed.
    await register({ ...body, mobile: undefined }).expect(400);
    for (const mobile of ['', '12345', '+91 12', 'call me']) {
      const res = await register({ ...body, mobile }).expect(400);
      expect(res.body.error.code).toBe('INVALID_PHONE_NUMBER');
    }
    expect((await safetyRow(h.safetyId)).activationPinUsed).toBe(false);
    // Local format is read as an Indian number (DEFAULT_PHONE_REGION).
    const res = await register({ ...body, mobile: '098765 43210' }).expect(200);
    expect(res.body.data.customer.mobile).toBe('+919876543210');
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: res.body.data.customer.id },
    });
    expect(user).toMatchObject({ mobile: '+919876543210', mobileVerified: false });
  });

  it('validate checks eligibility AND the PIN without consuming anything', async () => {
    const h = await createTestHelmet(ctx, 'SOLD');
    const ok = await validate({ publicToken: h.publicToken, pin: h.pin.toLowerCase() }).expect(200);
    expect(ok.body.data).toEqual({
      activatable: true,
      safetyId: { safetyCode: h.safetyCode },
      linkedHelmet: { modelName: 'Roadster X1', brand: 'Ozzo', helmetCode: h.helmetCode },
    });
    // Phase 8 cards print the Helmet ID: it still selects the linked Safety ID.
    const byCode = await validate({
      helmetCode: h.helmetCode.replace(/-/g, ''),
      pin: h.pin,
    }).expect(200);
    expect(byCode.body.data.linkedHelmet.helmetCode).toBe(h.helmetCode);
    const bySafetyCode = await validate({
      safetyCode: h.safetyCode.toLowerCase(),
      pin: h.pin,
    }).expect(200);
    expect(bySafetyCode.body.data.safetyId.safetyCode).toBe(h.safetyCode);
    expect(
      (await validate({ publicToken: h.publicToken, pin: 'ZZZZ9999' }).expect(400)).body.error.code,
    ).toBe('INVALID_ACTIVATION_PIN');
    expect(await safetyRow(h.safetyId)).toMatchObject({
      status: 'PRINTED',
      activationPinUsed: false,
      activationAttempts: 1,
    });
    expect((await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: h.id } })).status).toBe(
      'SOLD',
    );
    expect(
      await ctx.prisma.safetyIdActivationSecret.count({ where: { safetyId: h.safetyId } }),
    ).toBe(1);
  });

  it('before the PIN is proven, unknown, ineligible, owned and wrong-PIN all get one answer', async () => {
    const recalled = await createTestHelmet(ctx, 'RECALLED');
    const owned = await newCustomer(ctx);
    const fresh = await createTestHelmet(ctx, 'SOLD');
    const wrong = '999999';
    const answers = [
      await validate({ publicToken: 'A'.repeat(22), pin: wrong }).expect(400),
      await validate({ safetyCode: generateSafetyCode(), pin: wrong }).expect(400),
      await validate({ publicToken: recalled.publicToken, pin: wrong }).expect(400),
      await validate({ publicToken: owned.helmet.publicToken, pin: wrong }).expect(400),
      await validate({ publicToken: fresh.publicToken, pin: wrong }).expect(400),
    ];
    for (const r of answers)
      expect(r.body.error).toEqual({
        code: 'INVALID_ACTIVATION_PIN',
        message: answers[0]!.body.error.message,
        requestId: expect.any(String),
      });
    // With the right PIN the holder learns the (generic) reason.
    for (const h of [recalled, owned.helmet]) {
      const r = await validate({ publicToken: h.publicToken, pin: h.pin }).expect(409);
      expect(r.body.error.code).toBe('SAFETY_ID_NOT_ACTIVATABLE');
    }
  });

  it('first activation creates the account, ownership, consumes the PIN, purges escrow, ACTIVATED — atomically', async () => {
    const h = await createTestHelmet(ctx, 'SOLD');
    const res = await register({
      publicToken: h.publicToken,
      pin: h.pin,
      password: TEST_PASSWORD,
      name: 'Asha',
    }).expect(200);
    expect(res.body.data).toMatchObject({
      safetyId: {
        id: h.safetyId,
        safetyCode: h.safetyCode,
        status: 'ACTIVATED',
        emergencySharing: false,
        linkedHelmet: { id: h.id, helmetCode: h.helmetCode },
      },
      helmet: { id: h.id, status: 'ACTIVATED', emergencyProfileStatus: 'NOT_CONFIGURED' },
      customer: { name: 'Asha' },
    });
    expect(res.body.data.recoveryCode).toMatch(/^RK-/);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /helmet_customer_rt=.*HttpOnly/i,
    );

    const row = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: h.id } });
    expect(row).toMatchObject({
      status: 'ACTIVATED',
      activationPinUsed: true,
      activationAttempts: 0,
    });
    expect(row.activatedAt).not.toBeNull();
    const owners = await ctx.prisma.helmetOwnership.findMany({ where: { helmetId: h.id } });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ userId: res.body.data.customer.id, status: 'ACTIVE' });
    // The Safety ID and its linked helmet have the same owner, in the same transaction.
    expect(
      await ctx.prisma.safetyIdOwnership.findMany({ where: { safetyId: h.safetyId } }),
    ).toEqual([
      expect.objectContaining({
        userId: res.body.data.customer.id,
        status: 'ACTIVE',
        source: 'ACTIVATION',
      }),
    ]);
    expect(await safetyRow(h.safetyId)).toMatchObject({
      status: 'ACTIVATED',
      activationPinUsed: true,
      activationAttempts: 0,
    });
    expect(
      await ctx.prisma.safetyIdActivationSecret.count({ where: { safetyId: h.safetyId } }),
    ).toBe(0);
    expect(
      await ctx.prisma.helmetStatusHistory.count({
        where: { helmetId: h.id, fromStatus: 'SOLD', toStatus: 'ACTIVATED' },
      }),
    ).toBe(1);
    for (const action of [
      'customer.created',
      'helmet.activated',
      'safety_id.activated',
      'safety_id.activation_pin.consumed',
    ])
      expect(await ctx.prisma.auditLog.count({ where: { action } })).toBe(1);
    expect(
      (await ctx.http().get(`/api/v1/public/emergency/${h.publicToken}`).expect(200)).body.data
        .state,
    ).toBe('ACTIVATED_PROFILE_INCOMPLETE');
  });

  it('rejects weak passwords and the PIN as password before touching the helmet', async () => {
    const h = await createTestHelmet(ctx, 'SOLD');
    expect(
      (await register({ publicToken: h.publicToken, pin: h.pin, password: 'short' }).expect(400))
        .body.error.code,
    ).toBe('WEAK_PASSWORD');
    expect(
      (
        await register({
          publicToken: h.publicToken,
          pin: h.pin,
          password: h.pin.toLowerCase(),
        }).expect(400)
      ).body.error.code,
    ).toBe('WEAK_PASSWORD');
    expect(await ctx.prisma.user.count()).toBe(0);
    expect(
      (await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: h.id } })).activationAttempts,
    ).toBe(0);
  });

  it('a wrong PIN at registration creates no account and no ownership', async () => {
    const h = await createTestHelmet(ctx, 'SOLD');
    expect(
      (
        await register({
          publicToken: h.publicToken,
          pin: 'ZZZZ9999',
          password: TEST_PASSWORD,
        }).expect(400)
      ).body.error.code,
    ).toBe('INVALID_ACTIVATION_PIN');
    expect(await ctx.prisma.user.count()).toBe(0);
    expect(await ctx.prisma.helmetOwnership.count()).toBe(0);
  });

  it('the PIN can never be reused — not to register again, not by another customer', async () => {
    const c = await newCustomer(ctx);
    expect(
      (
        await register({
          publicToken: c.helmet.publicToken,
          pin: c.helmet.pin,
          password: 'another passphrase here',
        }).expect(409)
      ).body.error.code,
    ).toBe('SAFETY_ID_ALREADY_ACTIVATED');
    const other = await newCustomer(ctx);
    expect(
      (
        await addHelmet(other.token, {
          publicToken: c.helmet.publicToken,
          pin: c.helmet.pin,
        }).expect(409)
      ).body.error.code,
    ).toBe('SAFETY_ID_ALREADY_ACTIVATED');
    expect(await ctx.prisma.helmetOwnership.count({ where: { helmetId: c.helmet.id } })).toBe(1);
  });

  it('an existing customer adds another Safety ID (with its helmet) without a new account', async () => {
    const c = await newCustomer(ctx);
    const second = await createTestHelmet(ctx, 'SOLD', 'WXYZ6789');
    const res = await addHelmet(c.token, { helmetCode: second.helmetCode, pin: second.pin }).expect(
      200,
    );
    expect(res.body.data.helmet).toMatchObject({ id: second.id, status: 'ACTIVATED' });
    expect(res.body.data.safetyId).toMatchObject({ id: second.safetyId, status: 'ACTIVATED' });
    // The Phase 8 path stays available as an alias during the deploy window.
    const third = await createTestHelmet(ctx, 'SOLD', 'QRST2345');
    await ctx
      .http()
      .post('/api/v1/customer/activation/add-helmet')
      .set(bearer(c.token))
      .send({ publicToken: third.publicToken, pin: third.pin })
      .expect(200);
    expect(await ctx.prisma.user.count()).toBe(1);
    const mine = await ctx.http().get('/api/v1/customer/helmets').set(bearer(c.token)).expect(200);
    expect(mine.body.data.map((h: { id: string }) => h.id).sort()).toEqual(
      [c.helmet.id, second.id, third.id].sort(),
    );
    await ctx
      .http()
      .post('/api/v1/customer/activation/add-safety-id')
      .send({ helmetCode: second.helmetCode, pin: second.pin })
      .expect(401);
  });

  it('lets exactly one of two simultaneous first activations win', async () => {
    const h = await createTestHelmet(ctx, 'SOLD');
    const results = await Promise.all([
      register({ publicToken: h.publicToken, pin: h.pin, password: 'first racer passphrase' }),
      register({ publicToken: h.publicToken, pin: h.pin, password: 'second racer passphrase' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
      'SAFETY_ID_ALREADY_ACTIVATED',
    );
    expect(
      await ctx.prisma.helmetOwnership.count({ where: { helmetId: h.id, status: 'ACTIVE' } }),
    ).toBe(1);
    // The loser's account was never created (account creation is inside the transaction).
    expect(await ctx.prisma.user.count()).toBe(1);
    expect(
      await ctx.prisma.helmetStatusHistory.count({
        where: { helmetId: h.id, toStatus: 'ACTIVATED' },
      }),
    ).toBe(1);
  });

  it('same helmet cannot belong to two existing customers racing to add it', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    const h = await createTestHelmet(ctx, 'SOLD');
    const results = await Promise.all([
      addHelmet(a.token, { publicToken: h.publicToken, pin: h.pin }),
      addHelmet(b.token, { publicToken: h.publicToken, pin: h.pin }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await ctx.prisma.helmetOwnership.count({ where: { helmetId: h.id, status: 'ACTIVE' } }),
    ).toBe(1);
  });

  it('brute-forcing the PIN triggers escalating per-Safety-ID lockouts (never permanent)', async () => {
    const h = await createTestHelmet(ctx, 'SOLD');
    for (let i = 0; i < 2; i++)
      expect(
        (await validate({ publicToken: h.publicToken, pin: 'ZZZZ9999' }).expect(400)).body.error
          .code,
      ).toBe('INVALID_ACTIVATION_PIN');
    expect(
      (await validate({ publicToken: h.publicToken, pin: 'ZZZZ9999' }).expect(429)).body.error.code,
    ).toBe('ACTIVATION_ATTEMPTS_EXCEEDED');
    const locked = await register({
      publicToken: h.publicToken,
      pin: h.pin,
      password: TEST_PASSWORD,
    }).expect(429);
    expect(locked.body.error.details.retryAfter).toBeGreaterThan(0);
    const row = await safetyRow(h.safetyId);
    expect(row.activationLockedUntil!.getTime()).toBeLessThanOrEqual(
      Date.now() + 15 * 60_000 + 1000,
    );
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'safety_id.activation.locked', entityId: h.safetyId },
      }),
    ).toBe(1);
    expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain('ZZZZ9999');
    // Once the cooldown ends the real owner can still activate.
    await ctx.prisma.safetyId.update({
      where: { id: h.safetyId },
      data: { activationLockedUntil: new Date(Date.now() - 1000) },
    });
    await registerCustomer(ctx, h);
  });

  it('caps PIN failures per IP across many helmets', async () => {
    await ctx.redis.flushdb(); // start from an empty per-IP budget
    const helmets = [];
    for (let i = 0; i < 6; i++) helmets.push(await createTestHelmet(ctx, 'SOLD'));
    const statuses: number[] = [];
    for (let round = 0; round < 2; round++)
      for (const h of helmets)
        statuses.push((await validate({ publicToken: h.publicToken, pin: 'ZZZZ9999' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('activates PRINTED, IN_INVENTORY and SOLD helmets — no sale or inventory record needed', async () => {
    for (const status of ['PRINTED', 'IN_INVENTORY', 'SOLD'] as const) {
      const h = await createTestHelmet(ctx, status);
      const res = await register({
        publicToken: h.publicToken,
        pin: h.pin,
        password: TEST_PASSWORD,
      }).expect(200);
      expect(res.body.data.helmet.status).toBe('ACTIVATED');
      const history = await ctx.prisma.helmetStatusHistory.findFirstOrThrow({
        where: { helmetId: h.id, toStatus: 'ACTIVATED' },
      });
      expect(history.fromStatus).toBe(status);
    }
  });

  it('refuses statuses that are not activatable', async () => {
    for (const status of ['GENERATED', 'RECALLED'] as const) {
      const h = await createTestHelmet(ctx, status);
      expect(
        (
          await register({
            publicToken: h.publicToken,
            pin: h.pin,
            password: TEST_PASSWORD,
          }).expect(409)
        ).body.error.code,
      ).toBe('SAFETY_ID_NOT_ACTIVATABLE');
    }
    // Neither attempt consumed anything.
    expect(await ctx.prisma.user.count()).toBe(0);
    expect(await ctx.prisma.safetyIdOwnership.count()).toBe(0);
  });

  it('the newly created account can sign in with its Helmet ID + password', async () => {
    const c = await newCustomer(ctx);
    expect((await loginCustomer(ctx, c.helmet.helmetCode)).res.status).toBe(200);
  });
});
