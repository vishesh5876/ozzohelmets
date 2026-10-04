import { isValidCustomerCode } from '@helmet/types';
import {
  bearer,
  createAdmin,
  createTestApp,
  login,
  loginCustomer,
  newCustomer,
  resetState,
  startTransfer,
  TEST_PASSWORD,
  type TestContext,
  uniqueEmail,
} from './utils';

describe('Customer ID (e2e)', () => {
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

  const loginWith = (identifier: string, password = TEST_PASSWORD) =>
    ctx.http().post('/api/v1/customer/auth/login').send({ identifier, password });

  it('every new account gets a permanent, valid, unique Customer ID', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    const me = await ctx.http().get('/api/v1/customer/auth/me').set(bearer(a.token)).expect(200);
    const code = me.body.data.customerId as string;
    expect(isValidCustomerCode(code)).toBe(true);
    const other = await ctx.http().get('/api/v1/customer/auth/me').set(bearer(b.token)).expect(200);
    expect(other.body.data.customerId).not.toBe(code);
    // The UUID is not the public identifier.
    expect(code).not.toContain(a.userId.slice(0, 8));
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'customer.created', userId: a.userId },
    });
    expect(audit.metadata).toMatchObject({ customerId: code });
  });

  it('signs in with the Customer ID (any case/spacing) and still with a Helmet ID', async () => {
    const a = await newCustomer(ctx);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    const viaCustomer = await loginWith(
      user.customerCode.toLowerCase().replaceAll('-', ' '),
    ).expect(200);
    expect(viaCustomer.body.data.customer).toMatchObject({
      id: a.userId,
      customerId: user.customerCode,
    });
    const viaHelmet = await loginWith(a.helmet.helmetCode).expect(200);
    expect(viaHelmet.body.data.customer.id).toBe(a.userId);
    // Legacy field name still accepted.
    expect((await loginCustomer(ctx, a.helmet.helmetCode)).res.status).toBe(200);
  });

  it('a customer who transferred away their only helmet can still sign in with the Customer ID', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx, 'another rider phrase');
    const { customerCode } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    await ctx
      .http()
      .post('/api/v1/customer/transfers/claim')
      .set(bearer(b.token))
      .send({ helmetCode: a.helmet.helmetCode, transferCode })
      .expect(200);
    // The Helmet ID no longer identifies A …
    expect((await loginWith(a.helmet.helmetCode)).status).toBe(401);
    // … but the Customer ID does, and A now has zero helmets.
    const res = await loginWith(customerCode).expect(200);
    const helmets = await ctx
      .http()
      .get('/api/v1/customer/helmets')
      .set(bearer(res.body.data.accessToken))
      .expect(200);
    expect(helmets.body.data).toEqual([]);
  });

  it('transfer-created accounts get a Customer ID too', async () => {
    const a = await newCustomer(ctx);
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    const res = await ctx
      .http()
      .post('/api/v1/customer/transfers/claim/register')
      .send({
        helmetCode: a.helmet.helmetCode,
        transferCode,
        email: uniqueEmail(),
        password: 'fresh owner phrase',
      })
      .expect(200);
    expect(isValidCustomerCode(res.body.data.customer.customerId)).toBe(true);
    await loginWith(res.body.data.customer.customerId, 'fresh owner phrase').expect(200);
  });

  it('keeps errors generic and rejects malformed IDs before any lookup', async () => {
    const a = await newCustomer(ctx);
    const { customerCode } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    const wrongPassword = await loginWith(customerCode, 'not the password').expect(401);
    // A well-formed Customer ID that does not exist (valid check symbol, never issued).
    const { generateCustomerCode } = await import('../src/security/helmet-identity.generator');
    let unknown = generateCustomerCode();
    while (await ctx.prisma.user.findUnique({ where: { customerCode: unknown } }))
      unknown = generateCustomerCode();
    const unknownRes = await loginWith(unknown).expect(401);
    expect(unknownRes.body.error).toMatchObject({
      code: wrongPassword.body.error.code,
      message: wrongPassword.body.error.message,
    });
    // A typo (bad check symbol) is a validation error, not an account lookup.
    const typo = customerCode.slice(0, -1) + (customerCode.endsWith('2') ? '3' : '2');
    expect((await loginWith(typo).expect(400)).body.error.code).toBe('VALIDATION_ERROR');
  });

  it('account recovery works with the Customer ID', async () => {
    const a = await newCustomer(ctx);
    const { customerCode } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    const rec = await ctx
      .http()
      .post('/api/v1/customer/auth/recover')
      .send({ identifier: customerCode, recoveryCode: a.recoveryCode })
      .expect(200);
    await ctx
      .http()
      .post('/api/v1/customer/auth/reset-password')
      .send({ resetToken: rec.body.data.resetToken, newPassword: 'recovered by customer id' })
      .expect(200);
    await loginWith(customerCode, 'recovered by customer id').expect(200);
  });

  it('admins see the Customer ID (never the internal UUID) for the owner', async () => {
    await createAdmin(ctx, 'SUPPORT', 'support-cid@test.local');
    const support = await login(ctx, 'support-cid@test.local', 'Test-Password-123');
    const a = await newCustomer(ctx);
    const { customerCode } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    const detail = await ctx
      .http()
      .get(`/api/v1/admin/helmets/${a.helmet.id}`)
      .set(bearer(support.token))
      .expect(200);
    expect(detail.body.data.owner.customerId).toBe(customerCode);
    expect(JSON.stringify(detail.body)).not.toContain(a.userId);
  });

  it('the database enforces format and uniqueness', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    const { customerCode } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    await expect(
      ctx.prisma.user.update({ where: { id: b.userId }, data: { customerCode } }),
    ).rejects.toThrow();
    await expect(
      ctx.prisma.user.update({ where: { id: b.userId }, data: { customerCode: 'CU-0000-0000' } }),
    ).rejects.toThrow();
  });
});
