import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import request from 'supertest';
import type { AdminRole } from '@helmet/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from '../src/config/app-config.service';
import { validateEnv } from '../src/config/env.schema';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/infrastructure/redis/redis.constants';
import { HashingService } from '../src/security/hashing.service';

export interface TestContext {
  app: NestExpressApplication;
  prisma: PrismaService;
  redis: Redis;
  hashing: HashingService;
  http: () => ReturnType<typeof request>;
}

/**
 * @param overrides environment overrides for this app instance only (e.g. a dead REDIS_URL for
 * outage tests, a rotated keyring). Validated with the same schema as production.
 */
export async function createTestApp(overrides?: Record<string, string>): Promise<TestContext> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (overrides)
    builder = builder
      .overrideProvider(AppConfigService)
      .useValue(
        new AppConfigService(new ConfigService(validateEnv({ ...process.env, ...overrides }))),
      );
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  const redis = app.get<Redis>(REDIS_CLIENT);
  return {
    app,
    prisma: app.get(PrismaService),
    redis,
    hashing: app.get(HashingService),
    http: () => request(app.getHttpServer()),
  };
}

/** Removes all rows (keeps migrations) and test keys in Redis. */
export async function resetState(ctx: TestContext): Promise<void> {
  const dbName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  if (!dbName.endsWith('_test'))
    throw new Error(`Refusing to truncate non-test database "${dbName}"`);
  await ctx.prisma.$executeRawUnsafe(
    'TRUNCATE risk_alerts, platform_daily_stats, worker_job_runs, worker_heartbeats, helmet_transfers, helmet_replacements, helmet_emergency_settings, customer_refresh_tokens, emergency_contacts, emergency_visibility, emergency_profiles, helmet_scans, helmet_status_history, helmet_activation_secrets, helmet_ownerships, helmets, helmet_batches, helmet_models, audit_logs, admin_refresh_tokens, admin_users, users CASCADE',
  );
  await ctx.redis.flushdb();
}

export async function createAdmin(
  ctx: TestContext,
  role: AdminRole,
  email = `${role.toLowerCase()}@test.local`,
  password = 'Test-Password-123',
): Promise<{ id: string; email: string; password: string }> {
  const admin = await ctx.prisma.adminUser.create({
    data: { email, name: role, role, passwordHash: await ctx.hashing.hashPassword(password) },
  });
  return { id: admin.id, email, password };
}

export async function login(
  ctx: TestContext,
  email: string,
  password: string,
): Promise<{ token: string; cookie: string }> {
  const res = await ctx
    .http()
    .post('/api/v1/admin/auth/login')
    .send({ email, password })
    .expect(200);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return { token: res.body.data.accessToken as string, cookie: setCookie[0]!.split(';')[0]! };
}

export async function waitFor<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

export const TEST_PASSWORD = 'riding safe every day';

export interface CustomerSessionInfo {
  token: string;
  cookie: string;
  userId: string;
  recoveryCode: string;
  email: string;
}

let emailSeq = 0;
/** A unique, well-formed account email for tests. */
export function uniqueEmail(prefix = 'rider'): string {
  emailSeq += 1;
  return `${prefix}.${Date.now().toString(36)}.${emailSeq}@example.com`;
}

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  (res.headers['set-cookie'] as string[])[0]!.split(';')[0]!;

/** First activation of a helmet through the real API: creates the account and signs in. */
export async function registerCustomer(
  ctx: TestContext,
  helmet: { publicToken: string; pin: string },
  password = TEST_PASSWORD,
  name?: string,
  email = uniqueEmail(),
): Promise<CustomerSessionInfo> {
  const res = await ctx
    .http()
    .post('/api/v1/customer/activation/register')
    .send({ publicToken: helmet.publicToken, pin: helmet.pin, email, password, name })
    .expect(200);
  return {
    email,
    token: res.body.data.accessToken,
    cookie: cookieOf(res),
    userId: res.body.data.customer.id,
    recoveryCode: res.body.data.recoveryCode,
  };
}

/** Creates a SOLD helmet and registers a fresh customer with it. */
export async function newCustomer(ctx: TestContext, password = TEST_PASSWORD) {
  const helmet = await createTestHelmet(ctx, 'SOLD');
  const session = await registerCustomer(ctx, helmet, password);
  return { helmet, ...session };
}

export async function loginCustomer(
  ctx: TestContext,
  helmetCode: string,
  password = TEST_PASSWORD,
) {
  const res = await ctx.http().post('/api/v1/customer/auth/login').send({ helmetCode, password });
  return {
    res,
    token: res.body?.data?.accessToken as string | undefined,
    cookie: res.status === 200 ? cookieOf(res) : undefined,
  };
}

/** Creates one helmet directly in the given status with a known PIN (and escrow row). */
export async function createTestHelmet(
  ctx: TestContext,
  status: 'SOLD' | 'IN_INVENTORY' | 'PRINTED' | 'GENERATED' | 'RECALLED' = 'SOLD',
  pin = 'ABCD2345',
) {
  const { generateHelmetCode, generatePublicToken } =
    await import('../src/security/helmet-identity.generator');
  const { EncryptionService } = await import('../src/security/encryption.service');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const model = await ctx.prisma.helmetModel.upsert({
    where: { sku: 'TEST-MODEL' },
    update: {},
    create: { name: 'Roadster X1', sku: 'TEST-MODEL', brand: 'Ozzo' },
  });
  const batch = await ctx.prisma.helmetBatch.create({
    data: {
      batchCode: `BAT-T-${suffix}`,
      helmetModelId: model.id,
      manufacturingDate: new Date('2026-01-01'),
      quantity: 1,
      generatedCount: 1,
      generationStatus: 'COMPLETED',
    },
  });
  const helmet = await ctx.prisma.helmet.create({
    data: {
      helmetCode: generateHelmetCode(),
      publicToken: generatePublicToken(),
      activationPinHash: await ctx.hashing.hashPin(pin),
      serialNumber: `${batch.batchCode}-000001`,
      helmetModelId: model.id,
      batchId: batch.id,
      status,
    },
  });
  await ctx.prisma.helmetActivationSecret.create({
    data: {
      helmetId: helmet.id,
      pinCiphertext: ctx.app.get(EncryptionService).pinEscrow.encrypt(pin, helmet.id),
    },
  });
  return { ...helmet, pin };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const VISIBLE_BASICS = {
  showName: true,
  showPhoto: false,
  showBloodGroup: true,
  showDateOfBirth: false,
  showGender: false,
  showAllergies: true,
  showMedicalConditions: false,
  showMedications: false,
  showEmergencyNotes: false,
  showOrganDonor: false,
  showEmergencyContacts: true,
};

/** Completes the minimum profile (name, contact, reviewed visibility) without enabling it. */
export async function completeProfile(
  ctx: TestContext,
  token: string,
  name: string,
  allergy = 'Penicillin',
): Promise<void> {
  await ctx
    .http()
    .put('/api/v1/customer/emergency-profile')
    .set(bearer(token))
    .send({ name, bloodGroup: 'O_POSITIVE', allergies: [allergy] })
    .expect(200);
  await ctx
    .http()
    .post('/api/v1/customer/emergency-contacts')
    .set(bearer(token))
    .send({ name: `${name} Contact`, relationship: 'Sibling', phone: '+919812345678' })
    .expect(201);
  await ctx
    .http()
    .put('/api/v1/customer/emergency-visibility')
    .set(bearer(token))
    .send(VISIBLE_BASICS)
    .expect(200);
}

export async function enableOnHelmet(ctx: TestContext, token: string, helmetId: string) {
  await ctx
    .http()
    .post(`/api/v1/customer/helmets/${helmetId}/emergency/enable`)
    .set(bearer(token))
    .expect(200);
}

/** Password re-check → X-Recent-Auth token. */
export async function reauth(ctx: TestContext, token: string, password = TEST_PASSWORD) {
  const res = await ctx
    .http()
    .post('/api/v1/customer/auth/reauthenticate')
    .set(bearer(token))
    .send({ password })
    .expect(200);
  return res.body.data.recentAuthToken as string;
}

export async function publicView(ctx: TestContext, publicToken: string) {
  const res = await ctx.http().get(`/api/v1/public/emergency/${publicToken}`).expect(200);
  return res.body.data as {
    state: string;
    message: string;
    profile?: Record<string, unknown>;
    contacts?: unknown[];
    helmet: Record<string, unknown>;
  };
}

export async function startTransfer(ctx: TestContext, token: string, helmetId: string) {
  const recent = await reauth(ctx, token);
  const res = await ctx
    .http()
    .post(`/api/v1/customer/helmets/${helmetId}/transfer`)
    .set(bearer(token))
    .set('X-Recent-Auth', recent)
    .expect(200);
  return res.body.data as { transferCode: string; expiresAt: string };
}
