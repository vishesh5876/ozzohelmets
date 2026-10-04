import type { AdminRole } from '@helmet/types';
import {
  bearer,
  completeProfile,
  createAdmin,
  createTestHelmet,
  enableOnHelmet,
  login,
  loginCustomer,
  newCustomer,
  publicView,
  reauth,
  resetState,
  startTransfer,
  TEST_PASSWORD,
  type TestContext,
  createTestApp,
} from './utils';

/**
 * Phase 5: admin customer support, account status, recovery grants, sessions, privacy (export,
 * deletion requests), security events, customer isolation, public cache and QR abuse controls.
 * Real PostgreSQL + Redis.
 */
/** For helpers that build the request asynchronously (the awaited value is the Response). */
function expectStatus<T extends { status: number; body: unknown }>(res: T, status: number): T {
  expect({ status: res.status, body: res.status === status ? null : res.body }).toEqual({
    status,
    body: null,
  });
  return res;
}

describe('Phase 5 — customer support, privacy & security (e2e)', () => {
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

  const asAdmin = async (role: AdminRole) => {
    const a = await createAdmin(ctx, role, `${role.toLowerCase()}.${Date.now()}@test.local`);
    const { token } = await login(ctx, a.email, a.password);
    return { ...a, token };
  };
  const adminReauth = async (token: string, password = 'Test-Password-123') =>
    (
      await ctx
        .http()
        .post('/api/v1/admin/auth/reauthenticate')
        .set(bearer(token))
        .send({ password })
        .expect(200)
    ).body.data.recentAuthToken as string;
  const customerIdOf = async (userId: string) =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } })).customerCode;
  const refresh = (cookie: string) =>
    ctx
      .http()
      .post('/api/v1/customer/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch');
  const me = (token: string) => ctx.http().get('/api/v1/customer/auth/me').set(bearer(token));

  describe('admin customer search & detail', () => {
    it('finds customers by partial email, exact Customer ID and exact Helmet ID, paginated', async () => {
      const support = await asAdmin('SUPPORT');
      const a = await newCustomer(ctx);
      await newCustomer(ctx);
      const code = await customerIdOf(a.userId);
      const search = (q: string, extra: Record<string, string | number> = {}) =>
        ctx
          .http()
          .get('/api/v1/admin/customers')
          .query({ q, ...extra })
          .set(bearer(support.token));

      const fragment = `${a.email.split('@')[0]!.slice(-5)}@EXAMPLE`;
      const byEmail = (await search(fragment).expect(200)).body.data;
      expect(byEmail.matchedBy).toBe('email');
      // A partial address (local-part tail + domain prefix) finds the account.
      expect(byEmail.items.map((i: { customerId: string }) => i.customerId)).toContain(code);

      const exactEmail = (await search(a.email).expect(200)).body.data;
      expect(exactEmail.items).toHaveLength(1);
      expect(exactEmail.items[0]).toMatchObject({ customerId: code, activeHelmets: 1 });
      expect(exactEmail.items[0]).not.toHaveProperty('id');

      expect((await search(code.toLowerCase()).expect(200)).body.data.items[0].customerId).toBe(
        code,
      );
      const byHelmet = (await search(a.helmet.helmetCode).expect(200)).body.data;
      expect(byHelmet).toMatchObject({ matchedBy: 'helmetId', total: 1 });
      expect((await search('CU-ZZZZ-ZZZZ').expect(200)).body.data.total).toBe(0);
      await search('ab').expect(400);

      const page = (await search('', { page: 2, pageSize: 1 }).expect(200)).body.data;
      expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect(page.items).toHaveLength(1);
    });

    it('shows an operational summary without medical data, contacts or secrets; viewing is audited', async () => {
      const support = await asAdmin('SUPPORT');
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Asha Rider', 'Sulfa drugs');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      const code = await customerIdOf(c.userId);
      const res = await ctx
        .http()
        .get(`/api/v1/admin/customers/${code}`)
        .set(bearer(support.token))
        .expect(200);
      const d = res.body.data;
      expect(d).toMatchObject({
        customerId: code,
        email: c.email,
        emailVerified: false,
        status: 'ACTIVE',
        activeSessions: 1,
        emergency: { configured: true, enabled: true, contactCount: 1 },
        recovery: { recoveryCodeConfigured: true, openGrantExpiresAt: null },
      });
      expect(d.helmets[0]).toMatchObject({
        helmetCode: c.helmet.helmetCode,
        emergencySharing: true,
      });
      const json = JSON.stringify(d);
      for (const leak of [
        'Sulfa',
        'O_POSITIVE',
        'Asha Rider Contact',
        '+919812345678',
        'argon2',
        c.userId,
      ])
        expect(json).not.toContain(leak);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: 'admin.customer.viewed', adminId: support.id, userId: c.userId },
        }),
      ).toBe(1);
    });

    it('enforces the RBAC matrix on every Phase 5 admin endpoint', async () => {
      const c = await newCustomer(ctx);
      const code = await customerIdOf(c.userId);
      const roles = {
        MANUFACTURING: await asAdmin('MANUFACTURING'),
        ANALYTICS_VIEWER: await asAdmin('ANALYTICS_VIEWER'),
        SUPPORT: await asAdmin('SUPPORT'),
        ADMIN: await asAdmin('ADMIN'),
      };
      const call = (token: string, method: 'get' | 'post' | 'delete', path: string, body = {}) =>
        ctx.http()[method](`/api/v1${path}`).set(bearer(token)).send(body);
      const body = { reason: 'Verified by phone call today', confirmCustomerId: code };
      for (const r of [roles.MANUFACTURING, roles.ANALYTICS_VIEWER]) {
        await call(r.token, 'get', '/admin/customers').expect(403);
        await call(r.token, 'get', `/admin/customers/${code}`).expect(403);
        await call(r.token, 'get', '/admin/privacy-requests').expect(403);
      }
      await call(roles.ANALYTICS_VIEWER.token, 'post', `/admin/customers/${code}/status`, {
        action: 'SUSPEND',
        reason: 'not allowed',
      }).expect(403);
      // SUPPORT: search + manage, but no grants, deletion, privacy processing or security events.
      await call(roles.SUPPORT.token, 'get', `/admin/customers/${code}`).expect(200);
      await call(
        roles.SUPPORT.token,
        'post',
        `/admin/customers/${code}/recovery-grants`,
        body,
      ).expect(403);
      await call(roles.SUPPORT.token, 'post', `/admin/customers/${code}/delete`, body).expect(403);
      await call(roles.SUPPORT.token, 'get', `/admin/customers/${code}/security-events`).expect(
        403,
      );
      await call(roles.SUPPORT.token, 'get', '/admin/security-events').expect(403);
      // ADMIN: not the SUPER_ADMIN-only account recovery / deletion functions.
      await call(
        roles.ADMIN.token,
        'post',
        `/admin/customers/${code}/recovery-grants`,
        body,
      ).expect(403);
      await call(roles.ADMIN.token, 'post', `/admin/customers/${code}/delete`, body).expect(403);
      await call(
        roles.ADMIN.token,
        'post',
        `/admin/privacy-requests/00000000-0000-7000-8000-000000000000/approve`,
      ).expect(403);
      // Customers can never use admin endpoints (and vice versa).
      await call(c.token, 'get', '/admin/customers').expect(401);
    });
  });

  describe('account status', () => {
    it('suspension blocks sign-in and kills sessions, but emergency QR info stays available', async () => {
      const support = await asAdmin('SUPPORT');
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Ravi Rider');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      const code = await customerIdOf(c.userId);
      await ctx
        .http()
        .post(`/api/v1/admin/customers/${code}/status`)
        .set(bearer(support.token))
        .send({ action: 'SUSPEND', reason: 'Chargeback investigation' })
        .expect(200);
      await me(c.token).expect(401);
      await refresh(c.cookie).expect(401);
      expect((await loginCustomer(ctx, c.email)).res.status).toBe(401);
      // Authentication state and emergency availability are separate.
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view.state).toBe('ACTIVE');
      expect(view.profile?.name).toBe('Ravi Rider');
      // Invalid transitions are refused; restore re-enables sign-in.
      await ctx
        .http()
        .post(`/api/v1/admin/customers/${code}/status`)
        .set(bearer(support.token))
        .send({ action: 'SUSPEND', reason: 'again please' })
        .expect(409);
      await ctx
        .http()
        .post(`/api/v1/admin/customers/${code}/status`)
        .set(bearer(support.token))
        .send({ action: 'RESTORE', reason: 'Resolved with customer' })
        .expect(200);
      expect((await loginCustomer(ctx, c.email)).res.status).toBe(200);
      const events = await ctx.prisma.customerSecurityEvent.findMany({
        where: { userId: c.userId },
        select: { type: true },
      });
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(['ACCOUNT_SUSPENDED', 'ACCOUNT_RESTORED']),
      );
    });

    it('force logout ends every session immediately', async () => {
      const support = await asAdmin('SUPPORT');
      const c = await newCustomer(ctx);
      const code = await customerIdOf(c.userId);
      await ctx
        .http()
        .post(`/api/v1/admin/customers/${code}/logout-all`)
        .set(bearer(support.token))
        .send({ reason: 'Customer reported a lost phone' })
        .expect(200);
      await me(c.token).expect(401);
      await refresh(c.cookie).expect(401);
    });
  });

  describe('SUPER_ADMIN account recovery grant', () => {
    it('is single-use, short-lived, hashed, audited, and resets password + sessions + recovery code', async () => {
      const superAdmin = await asAdmin('SUPER_ADMIN');
      const c = await newCustomer(ctx);
      const code = await customerIdOf(c.userId);
      const issue = (headers: Record<string, string>, body: Record<string, string>) =>
        ctx
          .http()
          .post(`/api/v1/admin/customers/${code}/recovery-grants`)
          .set(bearer(superAdmin.token))
          .set(headers)
          .send(body);
      const body = {
        reason: 'Lost password and recovery code; ID verified',
        confirmCustomerId: code,
      };
      // Recent admin password required; Customer ID must be typed again.
      await issue({}, body).expect(403);
      await issue(
        { 'X-Recent-Auth': await adminReauth(superAdmin.token) },
        {
          ...body,
          confirmCustomerId: 'CU-AAAA-AAAQ',
        },
      ).expect(400);
      const res = await issue(
        { 'X-Recent-Auth': await adminReauth(superAdmin.token) },
        body,
      ).expect(201);
      const { credential, expiresAt } = res.body.data;
      expect(credential).toMatch(/^AR-/);
      expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
      const grant = await ctx.prisma.accountRecoveryGrant.findFirstOrThrow({
        where: { userId: c.userId },
      });
      expect(grant.credentialHash.startsWith('$argon2id$')).toBe(true);
      expect(JSON.stringify(grant)).not.toContain(credential);
      expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain(credential);

      // Customer: Customer ID + credential → reset token → new password.
      const recover = (recoveryCode: string) =>
        ctx.http().post('/api/v1/customer/auth/recover').send({ identifier: code, recoveryCode });
      const token = (await recover(credential.toLowerCase()).expect(200)).body.data.resetToken;
      const reset = await ctx
        .http()
        .post('/api/v1/customer/auth/reset-password')
        .send({ resetToken: token, newPassword: 'support helped me back in' })
        .expect(200);
      expect(reset.body.data.recoveryCode).toMatch(/^RK-/);
      // All old sessions are gone, the old password and old recovery code are dead.
      await me(c.token).expect(401);
      await refresh(c.cookie).expect(401);
      expect((await loginCustomer(ctx, c.email)).res.status).toBe(401);
      expect((await loginCustomer(ctx, c.email, 'support helped me back in')).res.status).toBe(200);
      await recover(c.recoveryCode).expect(401);
      // The grant cannot be reused.
      await recover(credential).expect(401);
      const used = await ctx.prisma.accountRecoveryGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(used.usedAt).not.toBeNull();
      expect(
        (
          await ctx.prisma.customerSecurityEvent.findMany({
            where: { userId: c.userId },
            select: { type: true },
          })
        ).map((e) => e.type),
      ).toEqual(
        expect.arrayContaining(['ACCOUNT_RECOVERY_GRANT_ISSUED', 'ACCOUNT_RECOVERY_GRANT_USED']),
      );
      // Admin view shows the state, never the secret.
      const detail = await ctx
        .http()
        .get(`/api/v1/admin/customers/${code}`)
        .set(bearer(superAdmin.token))
        .expect(200);
      expect(detail.body.data.recovery.lastGrantUsedAt).not.toBeNull();
      expect(JSON.stringify(detail.body.data)).not.toMatch(/AR-|argon2/);
    });

    it('expires, replaces an earlier grant, and requires an active account', async () => {
      const superAdmin = await asAdmin('SUPER_ADMIN');
      const c = await newCustomer(ctx);
      const code = await customerIdOf(c.userId);
      const issue = async () => {
        // Build the request only after the inner await (supertest binds the server lazily).
        const recent = await adminReauth(superAdmin.token);
        return ctx
          .http()
          .post(`/api/v1/admin/customers/${code}/recovery-grants`)
          .set(bearer(superAdmin.token))
          .set('X-Recent-Auth', recent)
          .send({ reason: 'Identity verified in person', confirmCustomerId: code });
      };
      const first = expectStatus(await issue(), 201).body.data.credential as string;
      const second = expectStatus(await issue(), 201).body.data.credential as string;
      const recover = (rc: string) =>
        ctx
          .http()
          .post('/api/v1/customer/auth/recover')
          .send({ identifier: code, recoveryCode: rc });
      await recover(first).expect(401);
      await ctx.prisma.accountRecoveryGrant.updateMany({
        where: { userId: c.userId, revokedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 60_000) },
      });
      await recover(second).expect(401);
      await ctx.prisma.user.update({ where: { id: c.userId }, data: { status: 'SUSPENDED' } });
      expect(expectStatus(await issue(), 409).body.error.code).toBe('CUSTOMER_NOT_ACTIVE');
    });
  });

  describe('customer sessions & security activity', () => {
    it('revoking one session ends it at once; revoke-others keeps the current one', async () => {
      const c = await newCustomer(ctx);
      const second = await loginCustomer(ctx, c.email);
      const third = await loginCustomer(ctx, c.email);
      const sessions = (
        await ctx.http().get('/api/v1/customer/auth/sessions').set(bearer(c.token)).expect(200)
      ).body.data;
      expect(sessions).toHaveLength(3);
      for (const s of sessions) {
        expect(s).toHaveProperty('device');
        expect(s).not.toHaveProperty('userAgent');
        expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
      }
      const secondId = sessions.find((s: { current: boolean }) => !s.current).id;
      // Customer B cannot revoke A's session.
      const b = await newCustomer(ctx);
      await ctx
        .http()
        .delete(`/api/v1/customer/auth/sessions/${secondId}`)
        .set(bearer(b.token))
        .expect(404);
      await ctx
        .http()
        .delete(`/api/v1/customer/auth/sessions/${secondId}`)
        .set(bearer(c.token))
        .expect(200);
      const statuses = await Promise.all(
        [me(second.token!), me(third.token!)].map(async (r) => (await r).status),
      );
      expect(statuses.sort()).toEqual([200, 401]);
      await ctx
        .http()
        .post('/api/v1/customer/auth/sessions/revoke-others')
        .set(bearer(c.token))
        .expect(200);
      await me(second.token!).expect(401);
      await me(third.token!).expect(401);
      await me(c.token).expect(200);
      const activity = (
        await ctx.http().get('/api/v1/customer/account/activity').set(bearer(c.token)).expect(200)
      ).body.data;
      expect(activity.map((e: { type: string }) => e.type)).toEqual(
        expect.arrayContaining([
          'LOGIN_SUCCESS',
          'SESSION_REVOKED',
          'ALL_SESSIONS_REVOKED',
          'HELMET_ACTIVATED',
        ]),
      );
      for (const e of activity)
        expect(Object.keys(e).sort()).toEqual(['createdAt', 'device', 'id', 'label', 'type']);
      // B never sees A's activity.
      const bActivity = (
        await ctx.http().get('/api/v1/customer/account/activity').set(bearer(b.token)).expect(200)
      ).body.data;
      expect(
        bActivity.every(
          (e: { id: string }) => !activity.some((a: { id: string }) => a.id === e.id),
        ),
      ).toBe(true);
    });

    it('password change revokes other sessions and records the event; lockouts span identifiers', async () => {
      const c = await newCustomer(ctx);
      const other = await loginCustomer(ctx, c.email);
      await ctx
        .http()
        .post('/api/v1/customer/auth/change-password')
        .set(bearer(c.token))
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'a brand new long passphrase' })
        .expect(200);
      await me(other.token!).expect(401);
      await me(c.token).expect(200);
      // Switching between email, Customer ID and Helmet ID doesn't reset the account lock (3).
      const code = await customerIdOf(c.userId);
      for (const id of [c.email, code, c.helmet.helmetCode])
        expect((await loginCustomer(ctx, id, 'wrong password here')).res.status).toBe(401);
      const locked = await loginCustomer(ctx, c.email, 'a brand new long passphrase');
      expect(locked.res.status).toBe(429);
      const events = await ctx.prisma.customerSecurityEvent.findMany({
        where: { userId: c.userId },
      });
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(['PASSWORD_CHANGED', 'LOGIN_FAILURE_THRESHOLD']),
      );
      for (const e of events) expect(JSON.stringify(e)).not.toMatch(/wrong password|passphrase/);
    });

    it('recovery code status and acknowledgement', async () => {
      const c = await newCustomer(ctx);
      const status = async () =>
        (await ctx.http().get('/api/v1/customer/account/security').set(bearer(c.token)).expect(200))
          .body.data;
      expect(await status()).toMatchObject({
        recoveryCodeConfigured: true,
        recoveryCodeAcknowledged: false,
      });
      await ctx
        .http()
        .post('/api/v1/customer/auth/recovery-code/acknowledge')
        .set(bearer(c.token))
        .expect(200);
      expect((await status()).recoveryCodeAcknowledged).toBe(true);
      const rotated = await ctx
        .http()
        .post('/api/v1/customer/auth/recovery-code')
        .set(bearer(c.token))
        .send({ password: TEST_PASSWORD })
        .expect(200);
      expect(rotated.body.data.recoveryCode).not.toBe(c.recoveryCode);
      expect((await status()).recoveryCodeAcknowledged).toBe(false);
      const dash = (
        await ctx.http().get('/api/v1/customer/dashboard').set(bearer(c.token)).expect(200)
      ).body.data;
      expect(dash.health.map((w: { code: string }) => w.code)).toContain(
        'RECOVERY_CODE_NOT_ACKNOWLEDGED',
      );
      expect(dash.completion.percent).toBeGreaterThanOrEqual(0);
      expect(dash.security.activeSessions).toBe(1);
    });
  });

  describe('privacy: export & deletion requests', () => {
    it('exports only the owner’s data behind recent auth', async () => {
      const a = await newCustomer(ctx);
      const b = await newCustomer(ctx, 'b owns a different passphrase');
      await completeProfile(ctx, a.token, 'Asha Export', 'Latex');
      await completeProfile(ctx, b.token, 'Bina Other', 'Shellfish');
      const exportReq = (token: string, recent?: string) => {
        const req = ctx.http().get('/api/v1/customer/account/export').set(bearer(token));
        return recent ? req.set('X-Recent-Auth', recent) : req;
      };
      await exportReq(a.token).expect(403);
      const res = await exportReq(a.token, await reauth(ctx, a.token)).expect(200);
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="helmet-account-CU-/,
      );
      const data = JSON.parse(res.text);
      expect(data.account.email).toBe(a.email);
      expect(data.emergencyProfile.allergies).toEqual(['Latex']);
      expect(data.helmets[0].helmetCode).toBe(a.helmet.helmetCode);
      expect(data.emergencyContacts).toHaveLength(1);
      expect(data.privacySettings).toHaveProperty('showName');
      const json = res.text;
      for (const leak of [
        'argon2',
        'Bina',
        'Shellfish',
        b.email,
        b.helmet.helmetCode,
        a.userId,
        'tokenHash',
        'ipHash',
      ])
        expect(json).not.toContain(leak);
      expect(
        await ctx.prisma.customerSecurityEvent.count({
          where: { userId: a.userId, type: 'DATA_EXPORTED' },
        }),
      ).toBe(1);
    });

    it('deletion: request → cancel → request → approve → complete (records kept, sharing off, email released)', async () => {
      const superAdmin = await asAdmin('SUPER_ADMIN');
      const support = await asAdmin('SUPPORT');
      const c = await newCustomer(ctx);
      const other = await newCustomer(ctx, 'other customer passphrase');
      await completeProfile(ctx, c.token, 'Delete Me');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      expect((await publicView(ctx, c.helmet.publicToken)).state).toBe('ACTIVE');
      const request = async (token: string) => {
        const recent = await reauth(ctx, token);
        return ctx
          .http()
          .post('/api/v1/customer/account/deletion-request')
          .set(bearer(token))
          .set('X-Recent-Auth', recent)
          .send({ reason: 'No longer riding' });
      };
      await ctx
        .http()
        .post('/api/v1/customer/account/deletion-request')
        .set(bearer(c.token))
        .send({})
        .expect(403);
      expectStatus(await request(c.token), 201);
      expect(expectStatus(await request(c.token), 409).body.error.code).toBe(
        'DELETION_REQUEST_EXISTS',
      );
      // Another customer can't see or cancel it.
      expect(
        (
          await ctx
            .http()
            .get('/api/v1/customer/account/deletion-request')
            .set(bearer(other.token))
            .expect(200)
        ).body.data,
      ).toBeNull();
      await ctx
        .http()
        .delete('/api/v1/customer/account/deletion-request')
        .set(bearer(other.token))
        .expect(404);
      const cancelled = await ctx
        .http()
        .delete('/api/v1/customer/account/deletion-request')
        .set(bearer(c.token))
        .expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expectStatus(await request(c.token), 201);

      // Support sees the queue (no medical content) but cannot process it.
      const queue = (
        await ctx
          .http()
          .get('/api/v1/admin/privacy-requests')
          .set(bearer(support.token))
          .expect(200)
      ).body.data;
      const open = queue.find((r: { status: string }) => r.status === 'REQUESTED');
      expect(open).toMatchObject({
        type: 'ACCOUNT_DELETION',
        customerId: await customerIdOf(c.userId),
      });
      expect(JSON.stringify(queue)).not.toMatch(/Penicillin|Delete Me/);
      await ctx
        .http()
        .post(`/api/v1/admin/privacy-requests/${open.id}/approve`)
        .set(bearer(support.token))
        .send({})
        .expect(403);

      await ctx
        .http()
        .post(`/api/v1/admin/privacy-requests/${open.id}/approve`)
        .set(bearer(superAdmin.token))
        .send({ note: 'ok' })
        .expect(200);
      await ctx
        .http()
        .post(`/api/v1/admin/privacy-requests/${open.id}/complete`)
        .set(bearer(superAdmin.token))
        .send({})
        .expect(403);
      const completeAuth = await adminReauth(superAdmin.token);
      const done = await ctx
        .http()
        .post(`/api/v1/admin/privacy-requests/${open.id}/complete`)
        .set(bearer(superAdmin.token))
        .set('X-Recent-Auth', completeAuth)
        .send({})
        .expect(200);
      expect(done.body.data.status).toBe('COMPLETED');
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
      expect(user.status).toBe('DELETED');
      await me(c.token).expect(401);
      // Ownership and records retained; public emergency information switched off immediately.
      expect(
        await ctx.prisma.helmetOwnership.count({ where: { userId: c.userId, status: 'ACTIVE' } }),
      ).toBe(1);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view.profile).toBeUndefined();
      // The email is released for a new account.
      const h = await createTestHelmet(ctx, 'SOLD');
      await ctx
        .http()
        .post('/api/v1/customer/activation/register')
        .send({
          publicToken: h.publicToken,
          pin: h.pin,
          email: c.email,
          password: 'a fresh account passphrase',
        })
        .expect(200);
    });
  });

  describe('public cache invalidation regression', () => {
    it('every owner change is visible on the next scan', async () => {
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Cache Rider', 'Bees');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      const view = () => publicView(ctx, c.helmet.publicToken);
      expect((await view()).profile?.allergies).toEqual(['Bees']); // populates the cache
      await ctx
        .http()
        .put('/api/v1/customer/emergency-profile')
        .set(bearer(c.token))
        .send({ allergies: ['Wasps'] })
        .expect(200);
      expect((await view()).profile?.allergies).toEqual(['Wasps']);
      const contacts = (
        await ctx.http().get('/api/v1/customer/emergency-contacts').set(bearer(c.token))
      ).body.data;
      await ctx
        .http()
        .patch(`/api/v1/customer/emergency-contacts/${contacts[0].id}`)
        .set(bearer(c.token))
        .send({ name: 'Renamed Contact' })
        .expect(200);
      expect(JSON.stringify((await view()).contacts)).toContain('Renamed Contact');
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/emergency/disable`)
        .set(bearer(c.token))
        .expect(200);
      expect((await view()).profile).toBeUndefined();
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      expect((await view()).profile).toBeDefined();
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/lost`)
        .set(bearer(c.token))
        .send({})
        .expect(200);
      expect((await view()).state).toBe('LOST');
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/found`)
        .set(bearer(c.token))
        .send({})
        .expect(200);
      expect((await view()).profile).toBeDefined();
      // Transfer: the previous owner's data disappears at once.
      const b = await newCustomer(ctx, 'new owner passphrase here');
      const { transferCode } = await startTransfer(ctx, c.token, c.helmet.id);
      await ctx
        .http()
        .post('/api/v1/customer/transfers/claim')
        .set(bearer(b.token))
        .send({ helmetCode: c.helmet.helmetCode, transferCode })
        .expect(200);
      expect(JSON.stringify(await view())).not.toContain('Cache Rider');
    });
  });

  describe('QR abuse controls', () => {
    it('blocks token enumeration but keeps serving cached emergency pages', async () => {
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Available Rider');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      await publicView(ctx, c.helmet.publicToken); // cached
      const other = await createTestHelmet(ctx, 'SOLD'); // valid but never scanned (uncached)
      const unknown = (i: number) => `${'A'.repeat(20)}${String(i).padStart(2, '0')}`;
      for (let i = 0; i < 6; i++)
        await ctx
          .http()
          .get(`/api/v1/public/emergency/${unknown(i)}`)
          .expect(404);
      await ctx.http().get('/api/v1/public/emergency/not-a-token').expect(404);
      // Flagged now: further uncached lookups are rationed (2), then refused.
      expect((await ctx.http().get(`/api/v1/public/emergency/${unknown(10)}`)).status).toBe(404);
      expect((await ctx.http().get(`/api/v1/public/emergency/${other.publicToken}`)).status).toBe(
        200,
      );
      const blocked = await ctx.http().get(`/api/v1/public/emergency/${unknown(11)}`);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      // The cached, genuinely scanned helmet keeps working for this IP.
      expect((await publicView(ctx, c.helmet.publicToken)).profile?.name).toBe('Available Rider');
    });
  });

  describe('medical encryption review', () => {
    it('medical fields exist only as versioned AES-GCM ciphertext columns in the database', async () => {
      const c = await newCustomer(ctx);
      await ctx
        .http()
        .put('/api/v1/customer/emergency-profile')
        .set(bearer(c.token))
        .send({
          name: 'Cipher Rider',
          allergies: ['Plaintextallergy'],
          medicalConditions: ['Plaintextcondition'],
          medications: ['Plaintextmedication'],
          emergencyNotes: 'Plaintextnote',
          dateOfBirth: '1990-01-02',
        })
        .expect(200);
      const columns = await ctx.prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'emergency_profiles'`;
      const names = columns.map((c) => c.column_name);
      for (const f of [
        'allergies',
        'medical_conditions',
        'medications',
        'emergency_notes',
        'date_of_birth',
      ]) {
        expect(names).toContain(`${f}_ciphertext`);
        expect(names).not.toContain(f);
      }
      const rows = await ctx.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        'SELECT * FROM emergency_profiles',
      );
      const raw = JSON.stringify(rows);
      for (const secret of [
        'Plaintextallergy',
        'Plaintextcondition',
        'Plaintextmedication',
        'Plaintextnote',
        '1990-01-02',
      ])
        expect(raw).not.toContain(secret);
      expect(String(rows[0]!.allergies_ciphertext)).toMatch(/^v\d+\.[\w-]+\.[\w-]+\.[\w-]+$/); // version.iv.tag.ciphertext
    });
  });

  describe('activation security review', () => {
    it('a successful activation clears failures; PINs never reach logs, audit or security events', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await ctx
        .http()
        .post('/api/v1/customer/activation/validate')
        .send({ publicToken: h.publicToken, pin: 'ZZZZ9999' })
        .expect(400);
      expect(
        (await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: h.id } })).activationAttempts,
      ).toBe(1);
      await ctx
        .http()
        .post('/api/v1/customer/activation/register')
        .send({
          publicToken: h.publicToken,
          pin: h.pin,
          email: 'pin.review@example.com',
          password: TEST_PASSWORD,
        })
        .expect(200);
      const row = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: h.id } });
      expect(row).toMatchObject({
        activationAttempts: 0,
        activationLockedUntil: null,
        activationPinUsed: true,
      });
      expect(await ctx.prisma.helmetActivationSecret.count({ where: { helmetId: h.id } })).toBe(0);
      const everything = JSON.stringify([
        await ctx.prisma.auditLog.findMany(),
        await ctx.prisma.customerSecurityEvent.findMany(),
      ]);
      expect(everything).not.toContain(h.pin);
      expect(everything).not.toContain('ZZZZ9999');
    });
  });

  describe('admin operations', () => {
    it('operations dashboard, helmet support summary, audit filters and report triage', async () => {
      const superAdmin = await asAdmin('SUPER_ADMIN');
      const support = await asAdmin('SUPPORT');
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Ops Rider');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      await publicView(ctx, c.helmet.publicToken);
      const code = await customerIdOf(c.userId);

      const ops = (
        await ctx
          .http()
          .get('/api/v1/admin/dashboard/operations')
          .set(bearer(superAdmin.token))
          .expect(200)
      ).body.data;
      expect(ops).toMatchObject({ activatedHelmets: 1, activeEmergencyProfiles: 1, customers: 1 });
      expect(ops.recentActivations[0].helmetCode).toBe(c.helmet.helmetCode);
      expect(Array.isArray(ops.recentSecurityEvents)).toBe(true);
      const supportOps = (
        await ctx
          .http()
          .get('/api/v1/admin/dashboard/operations')
          .set(bearer(support.token))
          .expect(200)
      ).body.data;
      expect(supportOps).not.toHaveProperty('recentSecurityEvents');

      const helmet = (
        await ctx
          .http()
          .get(`/api/v1/admin/helmets/${c.helmet.id}`)
          .set(bearer(support.token))
          .expect(200)
      ).body.data;
      expect(helmet.support.flags).toEqual(
        expect.arrayContaining(['ACTIVATED', 'EMERGENCY_ENABLED']),
      );
      expect(helmet.support.scans.emergency7d).toBe(1);
      expect(JSON.stringify(helmet)).not.toMatch(/Ops Rider|Penicillin|ip_?hash/i);

      await ctx
        .http()
        .get(`/api/v1/admin/customers/${code}`)
        .set(bearer(support.token))
        .expect(200);
      const audit = (
        await ctx
          .http()
          .get('/api/v1/admin/audit-logs')
          .query({ customerId: code, actorType: 'ADMIN' })
          .set(bearer(superAdmin.token))
          .expect(200)
      ).body.data;
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0]).toMatchObject({
        customerId: code,
        actorType: 'ADMIN',
        action: 'admin.customer.viewed',
      });
      expect(audit[0].label).toBe('Admin customer viewed');
      const byHelmet = (
        await ctx
          .http()
          .get('/api/v1/admin/audit-logs')
          .query({ helmetCode: c.helmet.helmetCode })
          .set(bearer(superAdmin.token))
          .expect(200)
      ).body.data;
      expect(byHelmet.every((r: { entityType: string }) => r.entityType === 'helmet')).toBe(true);

      await ctx
        .http()
        .post('/api/v1/public/product-reports')
        .send({
          publicToken: c.helmet.publicToken,
          reason: 'QR_COPIED',
          description: 'Seen on another helmet',
        })
        .expect(202);
      const report = (
        await ctx.http().get('/api/v1/admin/product-reports').set(bearer(support.token)).expect(200)
      ).body.data[0];
      expect(report).toMatchObject({ priority: 'NORMAL', assignee: null });
      const updated = (
        await ctx
          .http()
          .patch(`/api/v1/admin/product-reports/${report.id}`)
          .set(bearer(support.token))
          .send({
            priority: 'HIGH',
            assignedAdminId: support.id,
            status: 'REVIEWING',
            internalNote: 'Checking batch photos',
          })
          .expect(200)
      ).body.data;
      expect(updated).toMatchObject({
        priority: 'HIGH',
        status: 'REVIEWING',
        assignee: { id: support.id },
      });
      expect(updated.events.map((e: { type: string }) => e.type).sort()).toEqual([
        'ASSIGNED',
        'NOTE',
        'PRIORITY_CHANGED',
        'STATUS_CHANGED',
      ]);
      const mine = (
        await ctx
          .http()
          .get('/api/v1/admin/product-reports')
          .query({ assignee: 'me' })
          .set(bearer(support.token))
          .expect(200)
      ).body.data;
      expect(mine).toHaveLength(1);
      // Internal notes never reach the audit metadata.
      expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain(
        'Checking batch photos',
      );
    });
  });
});
