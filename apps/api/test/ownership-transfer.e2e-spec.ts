import {
  bearer,
  completeProfile,
  createTestApp,
  createTestHelmet,
  enableOnHelmet,
  loginCustomer,
  newCustomer,
  publicView,
  reauth,
  registerCustomer,
  resetState,
  startTransfer,
  TEST_PASSWORD,
  type TestContext,
  uniqueEmail,
} from './utils';

describe('Ownership transfer (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
  });

  const claim = (token: string, helmetCode: string, transferCode: string) =>
    ctx
      .http()
      .post('/api/v1/customer/transfers/claim')
      .set(bearer(token))
      .send({ helmetCode, transferCode });

  /** Owner A with an ACTIVE helmet exposing a full emergency profile. */
  async function activeOwner(name = 'Asha Verma') {
    const a = await newCustomer(ctx);
    await completeProfile(ctx, a.token, name, 'Peanuts');
    await enableOnHelmet(ctx, a.token, a.helmet.id);
    return a;
  }

  it('multiple helmets: one account, both listed, either Helmet ID signs in', async () => {
    const a = await newCustomer(ctx);
    const second = await createTestHelmet(ctx, 'SOLD');
    await ctx
      .http()
      .post('/api/v1/customer/activation/add-helmet')
      .set(bearer(a.token))
      .send({ publicToken: second.publicToken, pin: second.pin })
      .expect(200);
    const list = await ctx.http().get('/api/v1/customer/helmets').set(bearer(a.token)).expect(200);
    expect(list.body.data.map((h: { id: string }) => h.id).sort()).toEqual(
      [a.helmet.id, second.id].sort(),
    );
    const viaFirst = await loginCustomer(ctx, a.helmet.helmetCode);
    const viaSecond = await loginCustomer(ctx, second.helmetCode);
    expect(viaFirst.res.body.data.customer.id).toBe(a.userId);
    expect(viaSecond.res.body.data.customer.id).toBe(a.userId);
  });

  it('requires a recent password confirmation to create a transfer', async () => {
    const a = await newCustomer(ctx);
    const res = await ctx
      .http()
      .post(`/api/v1/customer/helmets/${a.helmet.id}/transfer`)
      .set(bearer(a.token))
      .expect(403);
    expect(res.body.error.code).toBe('RECENT_AUTH_REQUIRED');
    const wrong = await ctx
      .http()
      .post('/api/v1/customer/auth/reauthenticate')
      .set(bearer(a.token))
      .send({ password: 'not my password at all' })
      .expect(400);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('transfers to an existing customer atomically; the old owner loses everything immediately', async () => {
    const a = await activeOwner('Asha Verma');
    const b = await newCustomer(ctx);
    expect((await publicView(ctx, a.helmet.publicToken)).state).toBe('ACTIVE'); // cached now

    const { transferCode, expiresAt } = await startTransfer(ctx, a.token, a.helmet.id);
    expect(transferCode).toMatch(/^TR-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    const pending = await ctx
      .http()
      .get(`/api/v1/customer/helmets/${a.helmet.id}/transfer`)
      .set(bearer(a.token))
      .expect(200);
    expect(pending.body.data.pending).toBe(true);

    const preview = await ctx
      .http()
      .post('/api/v1/customer/transfers/preview')
      .send({ helmetCode: a.helmet.helmetCode, transferCode: transferCode.toLowerCase() })
      .expect(200);
    expect(preview.body.data.helmet).toEqual({
      helmetCode: a.helmet.helmetCode,
      modelName: 'Roadster X1',
      brand: 'Ozzo',
    });

    const claimed = await claim(b.token, a.helmet.helmetCode, transferCode).expect(200);
    expect(claimed.body.data.helmet).toMatchObject({
      id: a.helmet.id,
      status: 'ACTIVATED',
      acquiredVia: 'TRANSFER',
      emergencyEnabled: false,
    });

    // Old owner no longer controls the helmet; new owner does.
    await ctx
      .http()
      .get(`/api/v1/customer/helmets/${a.helmet.id}`)
      .set(bearer(a.token))
      .expect(404);
    await ctx
      .http()
      .post(`/api/v1/customer/helmets/${a.helmet.id}/lost`)
      .set(bearer(a.token))
      .expect(404);
    // The Helmet ID now identifies B's account (both use the test password here).
    const viaHelmet = await loginCustomer(ctx, a.helmet.helmetCode);
    expect(viaHelmet.res.body.data.customer.id).toBe(b.userId);
    const bList = await ctx.http().get('/api/v1/customer/helmets').set(bearer(b.token)).expect(200);
    expect(bList.body.data.map((h: { id: string }) => h.id)).toContain(a.helmet.id);

    // Public page: A's data gone at once (cache invalidated), B's not shown until enabled.
    const view = await publicView(ctx, a.helmet.publicToken);
    expect(view.state).toBe('ACTIVATED_PROFILE_INCOMPLETE');
    expect(JSON.stringify(view)).not.toContain('Asha');
    expect(JSON.stringify(view)).not.toContain('Peanuts');

    // History preserved: two periods, exactly one ACTIVE.
    const periods = await ctx.prisma.helmetOwnership.findMany({
      where: { helmetId: a.helmet.id },
      orderBy: { activatedAt: 'asc' },
    });
    expect(periods.map((p) => [p.userId, p.status])).toEqual([
      [a.userId, 'TRANSFERRED'],
      [b.userId, 'ACTIVE'],
    ]);
    expect(periods[0]!.endedAt).not.toBeNull();

    // Single use.
    const reuse = await claim(b.token, a.helmet.helmetCode, transferCode).expect(409);
    expect(reuse.body.error.code).toBe('TRANSFER_ALREADY_USED');

    // The code never reaches the audit log.
    const audit = JSON.stringify(await ctx.prisma.auditLog.findMany());
    expect(audit).not.toContain(transferCode);
    expect(audit).toContain('helmet.transfer.claimed');
  });

  it('new owner sees their own data on the public page only after enabling it', async () => {
    const a = await activeOwner('Asha Verma');
    const b = await newCustomer(ctx);
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    await claim(b.token, a.helmet.helmetCode, transferCode).expect(200);
    await completeProfile(ctx, b.token, 'Bilal Khan', 'Latex');
    expect((await publicView(ctx, a.helmet.publicToken)).state).toBe(
      'ACTIVATED_PROFILE_INCOMPLETE',
    );
    await enableOnHelmet(ctx, b.token, a.helmet.id);
    const view = await publicView(ctx, a.helmet.publicToken);
    expect(view.state).toBe('ACTIVE');
    expect(view.profile).toMatchObject({ name: 'Bilal Khan', allergies: ['Latex'] });
    expect(JSON.stringify(view)).not.toContain('Asha');
  });

  it('a new customer can claim by creating an account; recovery code is returned once', async () => {
    const a = await activeOwner();
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    const res = await ctx
      .http()
      .post('/api/v1/customer/transfers/claim/register')
      .send({
        helmetCode: a.helmet.helmetCode,
        transferCode,
        email: uniqueEmail(),
        password: 'brand new owner phrase',
        name: 'Chen',
      })
      .expect(200);
    expect(res.body.data.recoveryCode).toMatch(/^RK-/);
    expect(res.body.data.helmet.status).toBe('ACTIVATED');
    const userId = res.body.data.customer.id as string;
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.recoveryCodeHash).not.toContain(res.body.data.recoveryCode);
    // New owner signs in with the transferred Helmet ID + their own password.
    const login = await loginCustomer(ctx, a.helmet.helmetCode, 'brand new owner phrase');
    expect(login.res.status).toBe(200);
    expect(login.res.body.data.customer.id).toBe(userId);
    expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain(
      res.body.data.recoveryCode,
    );
  });

  it('weak passwords are rejected without consuming the code', async () => {
    const a = await newCustomer(ctx);
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    await ctx
      .http()
      .post('/api/v1/customer/transfers/claim/register')
      .send({
        helmetCode: a.helmet.helmetCode,
        transferCode,
        email: uniqueEmail(),
        password: 'password',
      })
      .expect(400);
    const b = await newCustomer(ctx);
    await claim(b.token, a.helmet.helmetCode, transferCode).expect(200);
  });

  it('blocks transfer to the current owner', async () => {
    const a = await newCustomer(ctx);
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    const res = await claim(a.token, a.helmet.helmetCode, transferCode).expect(409);
    expect(res.body.error.code).toBe('CANNOT_TRANSFER_TO_CURRENT_OWNER');
  });

  it('cancelled and superseded codes stop working', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    const first = await startTransfer(ctx, a.token, a.helmet.id);
    const second = await startTransfer(ctx, a.token, a.helmet.id);
    expect(
      (await claim(b.token, a.helmet.helmetCode, first.transferCode).expect(400)).body.error.code,
    ).toBe('TRANSFER_CODE_INVALID');
    await ctx
      .http()
      .delete(`/api/v1/customer/helmets/${a.helmet.id}/transfer`)
      .set(bearer(a.token))
      .expect(200);
    expect(
      (await claim(b.token, a.helmet.helmetCode, second.transferCode).expect(400)).body.error.code,
    ).toBe('TRANSFER_CODE_INVALID');
    await ctx
      .http()
      .delete(`/api/v1/customer/helmets/${a.helmet.id}/transfer`)
      .set(bearer(a.token))
      .expect(404);
    // Ownership and status untouched.
    const h = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: a.helmet.id } });
    expect(h.status).toBe('ACTIVATED');
    expect(
      await ctx.prisma.helmetOwnership.count({
        where: { helmetId: a.helmet.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('expired codes are refused', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    await ctx.prisma.helmetTransfer.updateMany({
      where: { helmetId: a.helmet.id, status: 'PENDING' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await claim(b.token, a.helmet.helmetCode, transferCode).expect(410);
    expect(res.body.error.code).toBe('TRANSFER_CODE_EXPIRED');
    const pending = await ctx
      .http()
      .get(`/api/v1/customer/helmets/${a.helmet.id}/transfer`)
      .set(bearer(a.token))
      .expect(200);
    expect(pending.body.data.pending).toBe(false);
  });

  it('transfer is blocked while lost, stolen or damaged — and a pending code dies', async () => {
    for (const action of ['lost', 'stolen', 'damaged'] as const) {
      const a = await newCustomer(ctx);
      const b = await newCustomer(ctx);
      const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
      const recent = await reauth(ctx, a.token);
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${a.helmet.id}/${action}`)
        .set(bearer(a.token))
        .set('X-Recent-Auth', recent)
        .send({})
        .expect(200);
      const create = await ctx
        .http()
        .post(`/api/v1/customer/helmets/${a.helmet.id}/transfer`)
        .set(bearer(a.token))
        .set('X-Recent-Auth', recent)
        .expect(409);
      expect(create.body.error.code).toBe('HELMET_NOT_TRANSFERABLE');
      await claim(b.token, a.helmet.helmetCode, transferCode).expect(400);
    }
  });

  it('brute force: escalating per-helmet lockout, codes never logged', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    const guess = 'TR-2222-3333-4444';
    // TRANSFER_FAILURES_BEFORE_LOCK = 3 in tests.
    await claim(b.token, a.helmet.helmetCode, guess).expect(400);
    await claim(b.token, a.helmet.helmetCode, guess).expect(400);
    const third = await claim(b.token, a.helmet.helmetCode, guess).expect(429);
    expect(third.body.error.code).toBe('TRANSFER_ATTEMPTS_EXCEEDED');
    expect(third.body.error.details.retryAfter).toBeGreaterThan(0);
    // Even the right code is refused while locked; unknown Helmet IDs look the same as wrong codes.
    await claim(b.token, a.helmet.helmetCode, transferCode).expect(429);
    const other = await createTestHelmet(ctx, 'SOLD');
    expect((await claim(b.token, other.helmetCode, transferCode).expect(400)).body.error.code).toBe(
      'TRANSFER_CODE_INVALID',
    );
    expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain(guess);
    // After the cooldown the legitimate claim works.
    await ctx.redis.flushdb();
    await claim(b.token, a.helmet.helmetCode, transferCode).expect(200);
  });

  it('race: two recipients claim the same code at once — exactly one wins', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await activeOwner();
      const b = await newCustomer(ctx);
      const c = await newCustomer(ctx);
      const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
      const results = await Promise.all([
        claim(b.token, a.helmet.helmetCode, transferCode),
        claim(c.token, a.helmet.helmetCode, transferCode),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe('TRANSFER_ALREADY_USED');
      const active = await ctx.prisma.helmetOwnership.findMany({
        where: { helmetId: a.helmet.id, status: 'ACTIVE' },
      });
      expect(active).toHaveLength(1);
      expect(
        await ctx.prisma.helmetTransfer.count({
          where: { helmetId: a.helmet.id, status: 'CLAIMED' },
        }),
      ).toBe(1);
      expect(await ctx.prisma.helmetOwnership.count({ where: { helmetId: a.helmet.id } })).toBe(2);
    }
  });

  it('race: claim vs. owner marking stolen — one action wins, final state is valid', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newCustomer(ctx);
      const b = await newCustomer(ctx);
      const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
      const recent = await reauth(ctx, a.token);
      const [claimRes, stolenRes] = await Promise.all([
        claim(b.token, a.helmet.helmetCode, transferCode),
        ctx
          .http()
          .post(`/api/v1/customer/helmets/${a.helmet.id}/stolen`)
          .set(bearer(a.token))
          .set('X-Recent-Auth', recent),
      ]);
      expect([claimRes.status, stolenRes.status].filter((s) => s === 200)).toHaveLength(1);
      const helmet = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: a.helmet.id } });
      const owner = await ctx.prisma.helmetOwnership.findFirstOrThrow({
        where: { helmetId: a.helmet.id, status: 'ACTIVE' },
      });
      if (claimRes.status === 200) {
        expect(owner.userId).toBe(b.userId);
        expect(helmet.status).toBe('ACTIVATED');
        expect(stolenRes.status).toBe(404); // A no longer owns it
      } else {
        expect(owner.userId).toBe(a.userId);
        expect(helmet.status).toBe('STOLEN');
      }
    }
  });

  it('the database refuses a second ACTIVE ownership (partial unique index)', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    await expect(
      ctx.prisma.helmetOwnership.create({
        data: { helmetId: a.helmet.id, userId: b.userId, status: 'ACTIVE' },
      }),
    ).rejects.toThrow();
    // …and a second PENDING transfer for one helmet.
    await startTransfer(ctx, a.token, a.helmet.id);
    await expect(
      ctx.prisma.helmetTransfer.create({
        data: {
          helmetId: a.helmet.id,
          fromUserId: a.userId,
          codeHash: 'f'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it('customer A cannot transfer, cancel or inspect a transfer of B’s helmet', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    const recent = await reauth(ctx, a.token);
    await ctx
      .http()
      .post(`/api/v1/customer/helmets/${b.helmet.id}/transfer`)
      .set(bearer(a.token))
      .set('X-Recent-Auth', recent)
      .expect(404);
    await ctx
      .http()
      .get(`/api/v1/customer/helmets/${b.helmet.id}/transfer`)
      .set(bearer(a.token))
      .expect(404);
    await ctx
      .http()
      .delete(`/api/v1/customer/helmets/${b.helmet.id}/transfer`)
      .set(bearer(a.token))
      .expect(404);
  });

  it('registering a helmet through activation still works next to transfers', async () => {
    const helmet = await createTestHelmet(ctx, 'SOLD');
    const s = await registerCustomer(ctx, helmet, TEST_PASSWORD);
    expect(s.recoveryCode).toMatch(/^RK-/);
  });
});
