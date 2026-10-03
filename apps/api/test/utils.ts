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
    'TRUNCATE helmet_scans, helmet_status_history, helmet_activation_secrets, helmet_ownerships, helmets, helmet_batches, helmet_models, audit_logs, admin_refresh_tokens, admin_users, users CASCADE',
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
