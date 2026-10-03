import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import request from 'supertest';
import type { AdminRole } from '@helmet/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
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

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    'TRUNCATE customer_refresh_tokens, emergency_contacts, emergency_visibility, emergency_profiles, helmet_scans, helmet_status_history, helmet_activation_secrets, helmet_ownerships, helmets, helmet_batches, helmet_models, audit_logs, admin_refresh_tokens, admin_users, users CASCADE',
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

/** Signs a customer in through the real OTP endpoints (development provider returns the code). */
export async function customerLogin(
  ctx: TestContext,
  mobile: string,
): Promise<{ token: string; cookie: string; userId: string; isNew: boolean }> {
  const otp = await ctx
    .http()
    .post('/api/v1/customer/auth/otp/request')
    .send({ mobile })
    .expect(200);
  const res = await ctx
    .http()
    .post('/api/v1/customer/auth/otp/verify')
    .send({ mobile, otp: otp.body.data.devOtp })
    .expect(200);
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return {
    token: res.body.data.accessToken,
    cookie: setCookie[0]!.split(';')[0]!,
    userId: res.body.data.customer.id,
    isNew: res.body.data.isNewCustomer,
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
