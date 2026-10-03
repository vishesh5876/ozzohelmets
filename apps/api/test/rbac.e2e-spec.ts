import { createAdmin, createTestApp, login, resetState, type TestContext } from './utils';

describe('RBAC enforcement (e2e)', () => {
  let ctx: TestContext;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    for (const role of [
      'SUPER_ADMIN',
      'ADMIN',
      'MANUFACTURING',
      'SUPPORT',
      'ANALYTICS_VIEWER',
    ] as const) {
      const admin = await createAdmin(ctx, role);
      tokens[role] = (await login(ctx, admin.email, admin.password)).token;
    }
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

  it('only SUPER_ADMIN can manage admin users', async () => {
    await ctx.http().get('/api/v1/admin/users').set(as('SUPER_ADMIN')).expect(200);
    for (const role of ['ADMIN', 'MANUFACTURING', 'SUPPORT', 'ANALYTICS_VIEWER']) {
      const res = await ctx.http().get('/api/v1/admin/users').set(as(role)).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('read-only roles cannot create helmet models', async () => {
    const body = { name: 'Role Test', sku: 'ROLE-TEST', brand: 'Ozzo' };
    await ctx.http().post('/api/v1/admin/helmet-models').set(as('SUPPORT')).send(body).expect(403);
    await ctx
      .http()
      .post('/api/v1/admin/helmet-models')
      .set(as('ANALYTICS_VIEWER'))
      .send(body)
      .expect(403);
    await ctx
      .http()
      .post('/api/v1/admin/helmet-models')
      .set(as('MANUFACTURING'))
      .send(body)
      .expect(201);
  });

  it('manufacturing staff cannot export activation PINs', async () => {
    const model = await ctx.prisma.helmetModel.findFirstOrThrow();
    const batch = await ctx
      .http()
      .post('/api/v1/admin/batches')
      .set(as('MANUFACTURING'))
      .send({ helmetModelId: model.id, manufacturingDate: '2026-10-01', quantity: 1 })
      .expect(201);
    const url = `/api/v1/admin/batches/${batch.body.data.id}/export/manufacturing.csv`;
    await ctx.http().get(url).set(as('MANUFACTURING')).expect(403);
    await ctx.http().get(url).set(as('SUPPORT')).expect(403);
    await ctx.http().get(url).set(as('ANALYTICS_VIEWER')).expect(403);
    // Admins are authorised (409: batch not generated yet, i.e. past the permission check).
    await ctx.http().get(url).set(as('ADMIN')).expect(409);
  });

  it('audit logs are restricted', async () => {
    await ctx.http().get('/api/v1/admin/audit-logs').set(as('ADMIN')).expect(200);
    await ctx.http().get('/api/v1/admin/audit-logs').set(as('MANUFACTURING')).expect(403);
  });

  it('SUPER_ADMIN can create admins; disabling revokes their sessions', async () => {
    const created = await ctx
      .http()
      .post('/api/v1/admin/users')
      .set(as('SUPER_ADMIN'))
      .send({
        name: 'New Support',
        email: 'new.support@test.local',
        password: 'Strong-Password-1',
        role: 'SUPPORT',
      })
      .expect(201);
    expect(created.body.data.passwordHash).toBeUndefined();
    await ctx
      .http()
      .post('/api/v1/admin/users')
      .set(as('SUPER_ADMIN'))
      .send({ name: 'Weak', email: 'weak@test.local', password: 'short', role: 'SUPPORT' })
      .expect(400);

    const session = await login(ctx, 'new.support@test.local', 'Strong-Password-1');
    await ctx
      .http()
      .patch(`/api/v1/admin/users/${created.body.data.id}`)
      .set(as('SUPER_ADMIN'))
      .send({ status: 'DISABLED' })
      .expect(200);
    await ctx
      .http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(401);
    await ctx
      .http()
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', session.cookie)
      .set('X-Requested-With', 'fetch')
      .expect(401);
  });
});
