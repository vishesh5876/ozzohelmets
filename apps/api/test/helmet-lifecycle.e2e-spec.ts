import {
  bearer,
  completeProfile,
  createAdmin,
  createTestApp,
  createTestHelmet,
  enableOnHelmet,
  login,
  newCustomer,
  publicView,
  reauth,
  resetState,
  startTransfer,
  TEST_PASSWORD,
  type TestContext,
} from './utils';

describe('Helmet lifecycle, support actions & replacement (e2e)', () => {
  let ctx: TestContext;
  let superAdmin: { token: string };
  let support: { token: string };
  let adminRole: { token: string };
  let manufacturing: { token: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    for (const [role, email] of [
      ['SUPER_ADMIN', 'super@test.local'],
      ['SUPPORT', 'support@test.local'],
      ['ADMIN', 'admin@test.local'],
      ['MANUFACTURING', 'mfg@test.local'],
    ] as const) {
      await createAdmin(ctx, role, email);
    }
    superAdmin = await login(ctx, 'super@test.local', 'Test-Password-123');
    support = await login(ctx, 'support@test.local', 'Test-Password-123');
    adminRole = await login(ctx, 'admin@test.local', 'Test-Password-123');
    manufacturing = await login(ctx, 'mfg@test.local', 'Test-Password-123');
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    // Clears rate-limit / lockout state between tests (sessions are JWT + DB).
    await ctx.redis.flushdb();
  });

  async function activeOwner(name = 'Dev Patel') {
    const c = await newCustomer(ctx);
    await completeProfile(ctx, c.token, name, 'Bee stings');
    await enableOnHelmet(ctx, c.token, c.helmet.id);
    return c;
  }

  const act = (token: string, helmetId: string, action: string, recent?: string, body = {}) => {
    const req = ctx
      .http()
      .post(`/api/v1/customer/helmets/${helmetId}/${action}`)
      .set(bearer(token));
    if (recent) req.set('X-Recent-Auth', recent);
    return req.send(body);
  };

  const adminReauth = async (token: string) =>
    (
      await ctx
        .http()
        .post('/api/v1/admin/auth/reauthenticate')
        .set(bearer(token))
        .send({ password: 'Test-Password-123' })
        .expect(200)
    ).body.data.recentAuthToken as string;

  describe('per-helmet emergency enablement', () => {
    it('never exposes data on a second helmet without explicit consent', async () => {
      const c = await activeOwner('Ira Sen');
      const second = await createTestHelmet(ctx, 'SOLD');
      await ctx
        .http()
        .post('/api/v1/customer/activation/add-helmet')
        .set(bearer(c.token))
        .send({ publicToken: second.publicToken, pin: second.pin })
        .expect(200);
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('ACTIVE');
      expect((await publicView(ctx, second.publicToken)).state).toBe(
        'ACTIVATED_PROFILE_INCOMPLETE',
      );
      // Account-level enable with several helmets in use switches nothing on implicitly.
      await ctx
        .http()
        .post('/api/v1/customer/emergency-profile/enable')
        .set(bearer(c.token))
        .send({})
        .expect(200);
      expect((await publicView(ctx, second.publicToken)).state).toBe(
        'ACTIVATED_PROFILE_INCOMPLETE',
      );
      const list = await ctx
        .http()
        .get('/api/v1/customer/helmets')
        .set(bearer(c.token))
        .expect(200);
      const secondDto = list.body.data.find((h: { id: string }) => h.id === second.id);
      expect(secondDto).toMatchObject({
        emergencyEnabled: false,
        emergencyProfileStatus: 'DISABLED',
      });
      expect(secondDto.availableActions).toContain('ENABLE_EMERGENCY');

      await enableOnHelmet(ctx, c.token, second.id);
      expect((await publicView(ctx, second.publicToken)).profile).toMatchObject({
        name: 'Ira Sen',
      });
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${second.id}/emergency/disable`)
        .set(bearer(c.token))
        .expect(200);
      expect((await publicView(ctx, second.publicToken)).state).toBe(
        'ACTIVATED_PROFILE_INCOMPLETE',
      );
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('ACTIVE');
    });
  });

  describe('lost', () => {
    it('ACTIVE → LOST hides data; found restores ACTIVE; ownership kept', async () => {
      const c = await activeOwner('Lena Roy');
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('ACTIVE'); // primes cache
      const lost = await act(c.token, c.helmet.id, 'lost').expect(200);
      expect(lost.body.data).toMatchObject({ status: 'LOST', group: 'NEEDS_ATTENTION' });
      expect(lost.body.data.availableActions).toEqual(['MARK_FOUND', 'REPORT_STOLEN', 'RETIRE']);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view).toMatchObject({ state: 'LOST', message: 'This helmet has been reported lost.' });
      expect(JSON.stringify(view)).not.toMatch(/Lena|Bee stings|9812345678/);
      expect((await act(c.token, c.helmet.id, 'lost').expect(409)).body.error.code).toBe(
        'HELMET_ALREADY_LOST',
      );

      const found = await act(c.token, c.helmet.id, 'found').expect(200);
      expect(found.body.data.status).toBe('ACTIVE');
      expect((await publicView(ctx, c.helmet.publicToken)).profile).toMatchObject({
        name: 'Lena Roy',
      });
      expect(
        await ctx.prisma.helmetOwnership.count({
          where: { helmetId: c.helmet.id, status: 'ACTIVE', userId: c.userId },
        }),
      ).toBe(1);
      const detail = await ctx
        .http()
        .get(`/api/v1/customer/helmets/${c.helmet.id}`)
        .set(bearer(c.token))
        .expect(200);
      expect(detail.body.data.timeline.map((e: { type: string }) => e.type)).toEqual([
        'ACTIVATED',
        'EMERGENCY_ENABLED',
        'REPORTED_LOST',
        'FOUND',
      ]);
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            entityId: c.helmet.id,
            action: { in: ['helmet.lifecycle.lost', 'helmet.lifecycle.found'] },
          },
        }),
      ).toBe(2);
    });

    it('ACTIVATED → LOST → found returns to ACTIVATED (never upgrades)', async () => {
      const c = await newCustomer(ctx);
      await act(c.token, c.helmet.id, 'lost').expect(200);
      expect((await act(c.token, c.helmet.id, 'found').expect(200)).body.data.status).toBe(
        'ACTIVATED',
      );
    });

    it('found falls back to ACTIVATED if the profile was disabled meanwhile', async () => {
      const c = await activeOwner();
      await act(c.token, c.helmet.id, 'lost').expect(200);
      await ctx
        .http()
        .post('/api/v1/customer/emergency-profile/disable')
        .set(bearer(c.token))
        .expect(200);
      expect((await act(c.token, c.helmet.id, 'found').expect(200)).body.data.status).toBe(
        'ACTIVATED',
      );
    });
  });

  describe('stolen', () => {
    it('needs recent auth; hides data; blocks transfer; recovery restores ACTIVE', async () => {
      const c = await activeOwner('Omar Ali');
      expect((await act(c.token, c.helmet.id, 'stolen').expect(403)).body.error.code).toBe(
        'RECENT_AUTH_REQUIRED',
      );
      const recent = await reauth(ctx, c.token);
      await act(c.token, c.helmet.id, 'stolen', recent).expect(200);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view).toMatchObject({
        state: 'STOLEN',
        message: 'This helmet has been reported stolen.',
      });
      expect(JSON.stringify(view)).not.toContain('Omar');
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/transfer`)
        .set(bearer(c.token))
        .set('X-Recent-Auth', recent)
        .expect(409);
      expect((await act(c.token, c.helmet.id, 'found').expect(409)).body.error.code).toBe(
        'HELMET_NOT_LOST',
      );
      await act(c.token, c.helmet.id, 'recovered').expect(403);
      expect(
        (await act(c.token, c.helmet.id, 'recovered', recent).expect(200)).body.data.status,
      ).toBe('ACTIVE');
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('ACTIVE');
    });

    it('LOST → STOLEN → recovered still remembers the original ACTIVE state', async () => {
      const c = await activeOwner();
      const recent = await reauth(ctx, c.token);
      await act(c.token, c.helmet.id, 'lost').expect(200);
      await act(c.token, c.helmet.id, 'stolen', recent).expect(200);
      expect(
        (await act(c.token, c.helmet.id, 'recovered', recent).expect(200)).body.data.status,
      ).toBe('ACTIVE');
    });
  });

  describe('damaged & retirement', () => {
    it('DAMAGED hides data, blocks transfer, stores only a reason code; retire is permanent', async () => {
      const c = await activeOwner('Maya Das');
      const damaged = await act(c.token, c.helmet.id, 'damaged', undefined, {
        reason: 'ACCIDENT',
        note: 'Dropped at a petrol station',
      }).expect(200);
      expect(damaged.body.data).toMatchObject({ status: 'DAMAGED', availableActions: ['RETIRE'] });
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view).toMatchObject({
        state: 'DAMAGED',
        message: 'This helmet is currently marked as damaged.',
      });
      expect(JSON.stringify(view)).not.toContain('Maya');
      const history = await ctx.prisma.helmetStatusHistory.findFirstOrThrow({
        where: { helmetId: c.helmet.id, toStatus: 'DAMAGED' },
      });
      expect(history.reasonCode).toBe('DAMAGED:ACCIDENT');
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { entityId: c.helmet.id, action: 'helmet.lifecycle.damaged' },
      });
      expect(JSON.stringify(audit.metadata)).not.toContain('petrol');
      await act(c.token, c.helmet.id, 'found').expect(409);

      // Retire: recent auth + typed Helmet ID.
      const recent = await reauth(ctx, c.token);
      await act(c.token, c.helmet.id, 'deactivate', undefined, {
        confirmHelmetCode: c.helmet.helmetCode,
      }).expect(403);
      expect(
        (
          await act(c.token, c.helmet.id, 'deactivate', recent, {
            confirmHelmetCode: 'HM-2222-2222',
          }).expect(400)
        ).body.error.code,
      ).toBe('CONFIRMATION_MISMATCH');
      const retired = await act(c.token, c.helmet.id, 'deactivate', recent, {
        confirmHelmetCode: c.helmet.helmetCode.toLowerCase(),
      }).expect(200);
      expect(retired.body.data).toMatchObject({
        status: 'DEACTIVATED',
        group: 'RETIRED',
        availableActions: [],
      });
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('DEACTIVATED');
      // Not reversible by the owner; ownership and history preserved.
      await act(c.token, c.helmet.id, 'found').expect(409);
      expect(
        await ctx.prisma.helmetOwnership.count({
          where: { helmetId: c.helmet.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      expect(
        await ctx.prisma.helmetStatusHistory.count({ where: { helmetId: c.helmet.id } }),
      ).toBeGreaterThanOrEqual(3);
    });
  });

  describe('recent auth', () => {
    it('expires, is session-bound, and dies on password change and logout-all', async () => {
      const c = await newCustomer(ctx);
      const recent = await reauth(ctx, c.token);
      // Expired (simulated by deleting the Redis entry the TTL would remove).
      await ctx.redis.flushdb();
      await act(c.token, c.helmet.id, 'stolen', recent).expect(403);

      const r2 = await reauth(ctx, c.token);
      await ctx
        .http()
        .post('/api/v1/customer/auth/change-password')
        .set(bearer(c.token))
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'a whole new passphrase' })
        .expect(200);
      expect((await act(c.token, c.helmet.id, 'stolen', r2).expect(403)).body.error.code).toBe(
        'RECENT_AUTH_REQUIRED',
      );

      const r3 = await reauth(ctx, c.token, 'a whole new passphrase');
      await ctx.http().post('/api/v1/customer/auth/logout-all').set(bearer(c.token)).expect(200);
      await act(c.token, c.helmet.id, 'stolen', r3).expect(403);
      // A token is useless for another customer.
      const other = await newCustomer(ctx);
      await act(other.token, other.helmet.id, 'stolen', r3).expect(403);
    });
  });

  describe('support actions & permissions', () => {
    it('enforces permissions per role', async () => {
      const c = await newCustomer(ctx);
      await act(c.token, c.helmet.id, 'lost').expect(200);
      const url = `/api/v1/admin/helmets/${c.helmet.id}`;
      await ctx.http().get(`${url}/ownership-history`).set(bearer(manufacturing.token)).expect(403);
      await ctx
        .http()
        .post(`${url}/restore-status`)
        .set(bearer(manufacturing.token))
        .send({ reason: 'test' })
        .expect(403);
      // ADMIN cannot revoke ownership (SUPER_ADMIN only); SUPPORT can view and restore.
      await ctx
        .http()
        .post(`${url}/revoke-ownership`)
        .set(bearer(adminRole.token))
        .send({ reason: 'test', targetStatus: 'DEACTIVATED' })
        .expect(403);
      await ctx
        .http()
        .post(`${url}/revoke-ownership`)
        .set(bearer(support.token))
        .send({ reason: 'test', targetStatus: 'DEACTIVATED' })
        .expect(403);
      const history = await ctx
        .http()
        .get(`${url}/ownership-history`)
        .set(bearer(support.token))
        .expect(200);
      expect(history.body.data[0]).toMatchObject({ status: 'ACTIVE', acquiredVia: 'ACTIVATION' });
      expect(JSON.stringify(history.body)).not.toMatch(/password|recovery|Hash/i);
      // Manufacturing can't push a customer-owned helmet around via the generic endpoint either.
      await ctx
        .http()
        .patch(`${url}/status`)
        .set(bearer(manufacturing.token))
        .send({ status: 'DEACTIVATED' })
        .expect(403);
      // Nobody can set an operational status through the generic endpoint.
      expect(
        (
          await ctx
            .http()
            .patch(`${url}/status`)
            .set(bearer(superAdmin.token))
            .send({ status: 'ACTIVATED' })
            .expect(409)
        ).body.error.code,
      ).toBe('INVALID_STATUS_TRANSITION');
    });

    it('support restores a retired helmet and cancels a pending transfer', async () => {
      const c = await activeOwner();
      const recent = await reauth(ctx, c.token);
      await act(c.token, c.helmet.id, 'deactivate', recent, {
        confirmHelmetCode: c.helmet.helmetCode,
      }).expect(200);
      const detail = await ctx
        .http()
        .get(`/api/v1/admin/helmets/${c.helmet.id}`)
        .set(bearer(support.token))
        .expect(200);
      expect(detail.body.data.restoreTarget).toBe('ACTIVATED');
      await ctx
        .http()
        .post(`/api/v1/admin/helmets/${c.helmet.id}/restore-status`)
        .set(bearer(support.token))
        .send({ reason: 'Retired by mistake (ticket 123)' })
        .expect(200);
      const h = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: c.helmet.id } });
      expect(h.status).toBe('ACTIVATED');
      // Restore never re-exposes data without the owner switching it on again.
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe(
        'ACTIVATED_PROFILE_INCOMPLETE',
      );

      await startTransfer(ctx, c.token, c.helmet.id);
      const withTransfer = await ctx
        .http()
        .get(`/api/v1/admin/helmets/${c.helmet.id}`)
        .set(bearer(support.token))
        .expect(200);
      expect(withTransfer.body.data.pendingTransfer).toMatchObject({ id: expect.any(String) });
      await ctx
        .http()
        .delete(`/api/v1/admin/helmets/${c.helmet.id}/transfer`)
        .set(bearer(support.token))
        .expect(200);
      const transfers = await ctx
        .http()
        .get(`/api/v1/admin/helmets/${c.helmet.id}/transfers`)
        .set(bearer(support.token))
        .expect(200);
      expect(transfers.body.data[0]).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'ADMIN_CANCELLED',
      });
      expect(JSON.stringify(transfers.body)).not.toContain('codeHash');
    });

    it('force-deactivate and revoke require a recent admin password', async () => {
      const c = await activeOwner('Zoe Lim');
      const url = `/api/v1/admin/helmets/${c.helmet.id}`;
      expect(
        (
          await ctx
            .http()
            .post(`${url}/force-deactivate`)
            .set(bearer(support.token))
            .send({ reason: 'Counterfeit report' })
            .expect(403)
        ).body.error.code,
      ).toBe('RECENT_AUTH_REQUIRED');
      await ctx
        .http()
        .post('/api/v1/admin/auth/reauthenticate')
        .set(bearer(superAdmin.token))
        .send({ password: 'wrong' })
        .expect(400);

      const recent = await adminReauth(superAdmin.token);
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('ACTIVE');
      await ctx
        .http()
        .post(`${url}/revoke-ownership`)
        .set(bearer(superAdmin.token))
        .set('X-Recent-Auth', recent)
        .send({ reason: 'Court order 42', targetStatus: 'ACTIVATED' })
        .expect(200);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view.state).toBe('UNAVAILABLE');
      expect(JSON.stringify(view)).not.toContain('Zoe');
      const periods = await ctx.prisma.helmetOwnership.findMany({
        where: { helmetId: c.helmet.id },
      });
      expect(periods).toHaveLength(1);
      expect(periods[0]).toMatchObject({ status: 'REVOKED', endReason: 'ADMIN_REVOKED' });
      // The customer lost control; the helmet isn't claimable by anyone else.
      await ctx
        .http()
        .get(`/api/v1/customer/helmets/${c.helmet.id}`)
        .set(bearer(c.token))
        .expect(404);
      expect(
        (
          await ctx
            .http()
            .post(`${url}/revoke-ownership`)
            .set(bearer(superAdmin.token))
            .set('X-Recent-Auth', recent)
            .send({ reason: 'again', targetStatus: 'ACTIVATED' })
            .expect(409)
        ).body.error.code,
      ).toBe('OWNERSHIP_ALREADY_REVOKED');
      expect(
        await ctx.prisma.auditLog.count({
          where: { entityId: c.helmet.id, action: 'helmet.ownership.revoked' },
        }),
      ).toBe(1);
    });
  });

  describe('forced deactivation', () => {
    it('support deactivates with a recent password; data disappears immediately', async () => {
      const c = await activeOwner('Noor Haq');
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('ACTIVE');
      const recent = await adminReauth(support.token);
      await ctx
        .http()
        .post(`/api/v1/admin/helmets/${c.helmet.id}/force-deactivate`)
        .set(bearer(support.token))
        .set('X-Recent-Auth', recent)
        .send({ reason: 'Owner request via support (ticket 9)' })
        .expect(200);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view.state).toBe('DEACTIVATED');
      expect(JSON.stringify(view)).not.toContain('Noor');
      // Another admin's recent-auth token is not accepted.
      const other = await createTestHelmet(ctx, 'SOLD');
      await ctx
        .http()
        .post(`/api/v1/admin/helmets/${other.id}/force-deactivate`)
        .set(bearer(adminRole.token))
        .set('X-Recent-Auth', recent)
        .send({ reason: 'not mine' })
        .expect(403);
    });
  });

  describe('replacement', () => {
    it('links a separately activated helmet; old → REPLACED; identities stay separate', async () => {
      const c = await activeOwner('Ravi Iyer');
      const replacement = await createTestHelmet(ctx, 'SOLD', 'WXYZ2345');
      await ctx
        .http()
        .post('/api/v1/customer/activation/add-helmet')
        .set(bearer(c.token))
        .send({ publicToken: replacement.publicToken, pin: replacement.pin })
        .expect(200);

      const link = (body: Record<string, unknown>, token = support.token) =>
        ctx.http().post('/api/v1/admin/replacements').set(bearer(token)).send(body);

      await link(
        {
          originalHelmetId: c.helmet.id,
          replacementHelmetCode: replacement.helmetCode,
          reason: 'DAMAGED',
        },
        manufacturing.token,
      ).expect(403);
      expect(
        (
          await link({
            originalHelmetId: c.helmet.id,
            replacementHelmetCode: c.helmet.helmetCode,
            reason: 'DAMAGED',
          }).expect(409)
        ).body.error.code,
      ).toBe('REPLACEMENT_INVALID');
      // A helmet owned by someone else can't be used as a replacement.
      const stranger = await newCustomer(ctx);
      await link({
        originalHelmetId: c.helmet.id,
        replacementHelmetCode: stranger.helmet.helmetCode,
        reason: 'DAMAGED',
      }).expect(409);

      const res = await link({
        originalHelmetId: c.helmet.id,
        replacementHelmetCode: replacement.helmetCode,
        reason: 'DAMAGED',
        notes: 'Crash replacement',
      }).expect(201);
      expect(res.body.data.replacedBy).toMatchObject({
        helmetId: replacement.id,
        helmetCode: replacement.helmetCode,
        reason: 'DAMAGED',
      });
      const [oldH, newH] = await Promise.all([
        ctx.prisma.helmet.findUniqueOrThrow({ where: { id: c.helmet.id } }),
        ctx.prisma.helmet.findUniqueOrThrow({ where: { id: replacement.id } }),
      ]);
      expect(oldH.status).toBe('REPLACED');
      expect(newH.status).toBe('ACTIVATED');
      expect(newH.helmetCode).not.toBe(oldH.helmetCode);
      expect(newH.publicToken).not.toBe(oldH.publicToken);
      expect(newH.activationPinHash).not.toBe(oldH.activationPinHash);
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('REPLACED');
      // The replacement needs explicit consent before showing the (same) profile.
      expect((await publicView(ctx, replacement.publicToken)).state).toBe(
        'ACTIVATED_PROFILE_INCOMPLETE',
      );
      await enableOnHelmet(ctx, c.token, replacement.id);
      expect((await publicView(ctx, replacement.publicToken)).profile).toMatchObject({
        name: 'Ravi Iyer',
      });

      // Each helmet can be linked once, and cycles are impossible.
      expect(
        (
          await link({
            originalHelmetId: replacement.id,
            replacementHelmetCode: c.helmet.helmetCode,
            reason: 'OTHER',
          }).expect(409)
        ).body.error.code,
      ).toBe('REPLACEMENT_INVALID');
      const list = await ctx
        .http()
        .get('/api/v1/customer/helmets')
        .set(bearer(c.token))
        .expect(200);
      const oldDto = list.body.data.find((h: { id: string }) => h.id === c.helmet.id);
      expect(oldDto).toMatchObject({
        status: 'REPLACED',
        group: 'RETIRED',
        replacedBy: { helmetCode: replacement.helmetCode },
      });
      const newDto = list.body.data.find((h: { id: string }) => h.id === replacement.id);
      expect(newDto.replaces).toEqual({ helmetCode: c.helmet.helmetCode });
    });
  });
});
