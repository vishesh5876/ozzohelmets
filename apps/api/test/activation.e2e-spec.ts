import {
  bearer,
  createTestApp,
  createTestHelmet,
  customerLogin,
  resetState,
  type TestContext,
} from './utils';

describe('Helmet activation (e2e)', () => {
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

  const complete = (token: string, body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/customer/activation/complete').set(bearer(token)).send(body);

  it('validates an activatable helmet by QR token or Helmet ID without auth or PIN', async () => {
    const helmet = await createTestHelmet(ctx, 'SOLD');
    const byToken = await ctx
      .http()
      .post('/api/v1/customer/activation/validate')
      .send({ publicToken: helmet.publicToken })
      .expect(200);
    expect(byToken.body.data).toEqual({
      activatable: true,
      helmet: { modelName: 'Roadster X1', brand: 'Ozzo', helmetCode: helmet.helmetCode },
    });
    const byCode = await ctx
      .http()
      .post('/api/v1/customer/activation/validate')
      .send({ helmetCode: helmet.helmetCode.toLowerCase().replace(/-/g, ' ') })
      .expect(200);
    expect(byCode.body.data.helmet.helmetCode).toBe(helmet.helmetCode);
    // Checksum failure is caught before any lookup.
    const typo = helmet.helmetCode.slice(0, -1) + (helmet.helmetCode.endsWith('2') ? '3' : '2');
    expect(
      (
        await ctx
          .http()
          .post('/api/v1/customer/activation/validate')
          .send({ helmetCode: typo })
          .expect(400)
      ).body.error.code,
    ).toBe('VALIDATION_ERROR');
  });

  it('gives the same answer for unknown, ineligible and already-owned helmets (no enumeration)', async () => {
    const printed = await createTestHelmet(ctx, 'PRINTED');
    const unknown = await ctx
      .http()
      .post('/api/v1/customer/activation/validate')
      .send({ publicToken: 'A'.repeat(22) })
      .expect(409);
    const ineligible = await ctx
      .http()
      .post('/api/v1/customer/activation/validate')
      .send({ publicToken: printed.publicToken })
      .expect(409);
    expect(unknown.body.error).toEqual(expect.objectContaining({ code: 'HELMET_NOT_ACTIVATABLE' }));
    expect(ineligible.body.error.code).toBe(unknown.body.error.code);
    expect(ineligible.body.error.message).toBe(unknown.body.error.message);
  });

  it('activates atomically: ownership, PIN consumed, escrow purged, ACTIVATED, history, audit', async () => {
    const helmet = await createTestHelmet(ctx, 'SOLD');
    const customer = await customerLogin(ctx, '+919876500001');
    const res = await complete(customer.token, {
      publicToken: helmet.publicToken,
      pin: helmet.pin.toLowerCase(),
    }).expect(200);
    expect(res.body.data.helmet).toMatchObject({
      id: helmet.id,
      helmetCode: helmet.helmetCode,
      status: 'ACTIVATED',
      emergencyProfileStatus: 'NOT_CONFIGURED',
    });

    const after = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: helmet.id } });
    expect(after).toMatchObject({
      status: 'ACTIVATED',
      activationPinUsed: true,
      activationAttempts: 0,
    });
    expect(after.activatedAt).not.toBeNull();
    const owners = await ctx.prisma.helmetOwnership.findMany({ where: { helmetId: helmet.id } });
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ userId: customer.userId, status: 'ACTIVE' });
    expect(await ctx.prisma.helmetActivationSecret.count({ where: { helmetId: helmet.id } })).toBe(
      0,
    );
    expect(
      await ctx.prisma.helmetStatusHistory.count({
        where: { helmetId: helmet.id, fromStatus: 'SOLD', toStatus: 'ACTIVATED' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          entityId: helmet.id,
          action: { in: ['helmet.activated', 'helmet.activation_pin.consumed'] },
        },
      }),
    ).toBe(2);

    const mine = await ctx
      .http()
      .get('/api/v1/customer/helmets')
      .set(bearer(customer.token))
      .expect(200);
    expect(mine.body.data.map((h: { id: string }) => h.id)).toEqual([helmet.id]);
    // Public page now reports the profile-incomplete state.
    const pub = await ctx.http().get(`/api/v1/public/emergency/${helmet.publicToken}`).expect(200);
    expect(pub.body.data.state).toBe('ACTIVATED_PROFILE_INCOMPLETE');
  });

  it('makes the PIN permanently unusable — for the owner and anyone else', async () => {
    const helmet = await createTestHelmet(ctx, 'SOLD');
    const owner = await customerLogin(ctx, '+919876500002');
    await complete(owner.token, { helmetCode: helmet.helmetCode, pin: helmet.pin }).expect(200);
    const replayOwner = await complete(owner.token, {
      helmetCode: helmet.helmetCode,
      pin: helmet.pin,
    }).expect(409);
    expect(replayOwner.body.error.code).toBe('HELMET_ALREADY_ACTIVATED');
    const other = await customerLogin(ctx, '+919876500003');
    const replayOther = await complete(other.token, {
      helmetCode: helmet.helmetCode,
      pin: helmet.pin,
    }).expect(409);
    expect(replayOther.body.error.code).toBe('HELMET_ALREADY_ACTIVATED');
    expect(await ctx.prisma.helmetOwnership.count({ where: { helmetId: helmet.id } })).toBe(1);
  });

  it('lets exactly one of two simultaneous activations win', async () => {
    const helmet = await createTestHelmet(ctx, 'SOLD');
    const a = await customerLogin(ctx, '+919876500004');
    const b = await customerLogin(ctx, '+919876500005');
    const results = await Promise.all([
      complete(a.token, { publicToken: helmet.publicToken, pin: helmet.pin }),
      complete(b.token, { publicToken: helmet.publicToken, pin: helmet.pin }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('HELMET_ALREADY_ACTIVATED');
    const owners = await ctx.prisma.helmetOwnership.findMany({
      where: { helmetId: helmet.id, status: 'ACTIVE' },
    });
    expect(owners).toHaveLength(1);
    const winner = results.find((r) => r.status === 200)!;
    expect([a.userId, b.userId]).toContain(owners[0]!.userId);
    expect(winner.body.data.customer.id).toBe(owners[0]!.userId);
    expect(
      await ctx.prisma.helmetStatusHistory.count({
        where: { helmetId: helmet.id, toStatus: 'ACTIVATED' },
      }),
    ).toBe(1);
  });

  it('rejects wrong PINs, counts failures and locks the helmet progressively', async () => {
    const helmet = await createTestHelmet(ctx, 'SOLD');
    const customer = await customerLogin(ctx, '+919876500006');
    for (let i = 0; i < 2; i++) {
      const res = await complete(customer.token, {
        publicToken: helmet.publicToken,
        pin: 'ZZZZ9999',
      }).expect(400);
      expect(res.body.error.code).toBe('INVALID_ACTIVATION_PIN');
    }
    // Third failure hits ACTIVATION_FAILURES_BEFORE_LOCK=3 (test env) → locked.
    const locked = await complete(customer.token, {
      publicToken: helmet.publicToken,
      pin: 'ZZZZ9999',
    }).expect(429);
    expect(locked.body.error.code).toBe('ACTIVATION_ATTEMPTS_EXCEEDED');
    // Even the correct PIN is refused while locked.
    const stillLocked = await complete(customer.token, {
      publicToken: helmet.publicToken,
      pin: helmet.pin,
    }).expect(429);
    expect(stillLocked.body.error.details.retryAfter).toBeGreaterThan(0);
    const row = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: helmet.id } });
    expect(row).toMatchObject({ activationAttempts: 3, activationPinUsed: false, status: 'SOLD' });
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'helmet.activation.locked', entityId: helmet.id },
      }),
    ).toBe(1);
    expect(await ctx.prisma.helmetOwnership.count()).toBe(0);
  });

  it('rate-limits a customer guessing across many helmets', async () => {
    const customer = await customerLogin(ctx, '+919876500007');
    const helmets = [];
    for (let i = 0; i < 5; i++) helmets.push(await createTestHelmet(ctx, 'SOLD'));
    let last = 0;
    for (let round = 0; round < 3; round++) {
      for (const h of helmets) {
        last = (await complete(customer.token, { publicToken: h.publicToken, pin: 'ZZZZ9999' }))
          .status;
        if (last === 429) break;
      }
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it('refuses statuses that are not activatable (configurable IN_INVENTORY allowance off)', async () => {
    const customer = await customerLogin(ctx, '+919876500008');
    for (const status of ['PRINTED', 'IN_INVENTORY', 'GENERATED', 'RECALLED'] as const) {
      const helmet = await createTestHelmet(ctx, status);
      const res = await complete(customer.token, {
        publicToken: helmet.publicToken,
        pin: helmet.pin,
      }).expect(409);
      expect(res.body.error.code).toBe('HELMET_NOT_ACTIVATABLE');
    }
  });

  it('requires an authenticated customer for completion', async () => {
    const helmet = await createTestHelmet(ctx, 'SOLD');
    await ctx
      .http()
      .post('/api/v1/customer/activation/complete')
      .send({ publicToken: helmet.publicToken, pin: helmet.pin })
      .expect(401);
    expect(
      (await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: helmet.id } })).activationPinUsed,
    ).toBe(false);
  });
});
