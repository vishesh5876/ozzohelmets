import { bootstrapAdmin } from '../src/cli/bootstrap-admin';
import { encryptionStatus, rotateEncryption } from '../src/cli/rotate-encryption';
import { SystemStatusService } from '../src/modules/system/system-status.service';
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
  resetState,
  TEST_PASSWORD,
  type TestContext,
} from './utils';

/**
 * Phase 7: health/readiness, Redis outage policy (real dead Redis), metrics protection and
 * labels, system status, admin bootstrap CLI and encryption key rotation.
 */
const METRICS = 'test-metrics-token-0123456789abcdef';
const key = (seed: string) => Buffer.alloc(32, seed).toString('base64');

describe('Phase 7 — operations (e2e)', () => {
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

  describe('health', () => {
    it('liveness has no dependency checks; readiness reports database and redis without config', async () => {
      const live = await ctx.http().get('/api/v1/health/live').expect(200);
      expect(live.body.data).toEqual({ status: 'ok' });
      const ready = await ctx.http().get('/api/v1/health/ready').expect(200);
      expect(ready.body.data).toEqual({ status: 'ok', database: 'up', redis: 'up' });
      expect(JSON.stringify(ready.body)).not.toMatch(/postgres(ql)?:\/\/|redis:\/\/|password/i);
      await ctx.http().get('/api/v1/health').expect(200);
    });
  });

  describe('Redis outage policy (API pointed at a dead Redis)', () => {
    it('serves known emergency pages from PostgreSQL, keeps auth fail-closed (503), readiness degraded', async () => {
      // Data prepared through the healthy app.
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Redis Down Rider');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      const unactivated = await createTestHelmet(ctx, 'SOLD');

      const down = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1/0' });
      try {
        const started = Date.now();
        const view = await down.http().get(`/api/v1/public/emergency/${c.helmet.publicToken}`);
        expect(view.status).toBe(200);
        expect(view.body.data.profile.name).toBe('Redis Down Rider');
        expect(Date.now() - started).toBeLessThan(8_000);
        expect(
          (await down.http().get(`/api/v1/public/emergency/${unactivated.publicToken}`)).status,
        ).toBe(200);
        expect(
          (await down.http().get(`/api/v1/public/verify/${c.helmet.publicToken}`)).status,
        ).toBe(200);
        // Unknown tokens still answer 404 (not 500) while abuse counters are unavailable.
        expect((await down.http().get(`/api/v1/public/emergency/${'Q'.repeat(22)}`)).status).toBe(
          404,
        );

        // Readiness: Postgres up → 200 "degraded".
        const ready = await down.http().get('/api/v1/health/ready').expect(200);
        expect(ready.body.data).toEqual({ status: 'degraded', database: 'up', redis: 'down' });

        // Auth routes fail closed with a clean 503 — never an unthrottled login.
        const loginRes = await down
          .http()
          .post('/api/v1/customer/auth/login')
          .send({ identifier: c.email, password: TEST_PASSWORD });
        expect(loginRes.status).toBe(503);
        expect(loginRes.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(JSON.stringify(loginRes.body)).not.toMatch(/stack|ioredis|ECONNREFUSED/i);
        // Session revocation can't be checked → authenticated customer calls fail closed too.
        const me = await down.http().get('/api/v1/customer/auth/me').set(bearer(c.token));
        expect(me.status).toBe(503);
      } finally {
        await down.app.close();
      }
      // The healthy app is unaffected.
      expect((await publicView(ctx, c.helmet.publicToken)).profile?.name).toBe('Redis Down Rider');
    });
  });

  describe('metrics', () => {
    it('requires the bearer token, exposes no personal labels, counts route templates', async () => {
      const c = await newCustomer(ctx);
      await ctx.http().get(`/api/v1/public/emergency/${c.helmet.publicToken}`).expect(200);
      await ctx.http().get('/api/v1/internal/metrics').expect(401);
      await ctx
        .http()
        .get('/api/v1/internal/metrics')
        .set(bearer('wrong-token-wrong-token-xx'))
        .expect(401);
      const res = await ctx.http().get('/api/v1/internal/metrics').set(bearer(METRICS)).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      const text = res.text;
      expect(text).toContain('helmet_http_requests_total{');
      expect(text).toContain('route="/api/v1/public/emergency/:token"');
      expect(text).toContain('helmet_audit_events_total{action="helmet.activated"}');
      expect(text).toMatch(
        /helmet_worker_job_last_success_timestamp_seconds\{job="risk.evaluate"\}/,
      );
      expect(text).toMatch(/helmet_redis_up 1/);
      expect(text).toMatch(/helmet_build_info\{git_sha="abc1234",version="1.0.0-test"\} 1/);
      for (const secret of [
        c.helmet.publicToken,
        c.helmet.helmetCode,
        c.email,
        c.userId,
        '127.0.0.1',
      ])
        expect(text).not.toContain(secret);
    });
  });

  describe('system status', () => {
    it('reports version, worker freshness and job state to admins only', async () => {
      const admin = await createAdmin(ctx, 'ANALYTICS_VIEWER', 'viewer.p7@test.local');
      const { token } = await login(ctx, admin.email, admin.password);
      await ctx.prisma.workerHeartbeat.create({
        data: {
          workerId: 'host:1',
          hostname: 'host',
          version: '1.0.0-test',
          startedAt: new Date(),
          lastBeatAt: new Date(),
        },
      });
      await ctx.prisma.workerJobRun.create({
        data: {
          job: 'risk.evaluate',
          status: 'SUCCEEDED',
          startedAt: new Date(),
          finishedAt: new Date(),
          durationMs: 12,
          worker: 'host:1',
        },
      });
      const res = await ctx
        .http()
        .get('/api/v1/admin/system/status')
        .set(bearer(token))
        .expect(200);
      const s = res.body.data;
      expect(s.api).toMatchObject({ version: '1.0.0-test', gitSha: 'abc1234' });
      expect(s.worker).toMatchObject({ alive: 1, version: '1.0.0-test' });
      const risk = s.jobs.find((j: { job: string }) => j.job === 'risk.evaluate');
      expect(risk).toMatchObject({ lastStatus: 'SUCCEEDED', stale: false, lastDurationMs: 12 });
      expect(s.jobs.find((j: { job: string }) => j.job === 'retention.cleanup').stale).toBe(true);
      expect(s.dependencies).toEqual({ database: 'up', redis: 'up' });
      expect(JSON.stringify(s)).not.toMatch(/secret|password|postgres(ql)?:\/\//i);
      await ctx.http().get('/api/v1/admin/system/status').expect(401);
      // Stale worker → alive 0.
      await ctx.prisma.workerHeartbeat.update({
        where: { workerId: 'host:1' },
        data: { lastBeatAt: new Date(Date.now() - 5 * 60_000) },
      });
      expect((await ctx.app.get(SystemStatusService).status()).worker.alive).toBe(0);
    });
  });

  describe('admin bootstrap CLI', () => {
    it('creates the first SUPER_ADMIN once, enforces the password rule, audits, then refuses', async () => {
      await expect(
        bootstrapAdmin(ctx.app, { email: 'ops@example.com', name: 'Ops', password: 'short' }),
      ).rejects.toThrow(/Password must be/);
      const id = await bootstrapAdmin(ctx.app, {
        email: 'Ops@Example.com',
        name: 'Ops Lead',
        password: 'Bootstrap-Passw0rd-1',
      });
      const admin = await ctx.prisma.adminUser.findUniqueOrThrow({ where: { id } });
      expect(admin).toMatchObject({ email: 'ops@example.com', role: 'SUPER_ADMIN' });
      expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
      await login(ctx, 'ops@example.com', 'Bootstrap-Passw0rd-1');
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin_user.created', entityId: id },
      });
      expect(JSON.stringify(audit.metadata)).not.toContain('Bootstrap-Passw0rd-1');
      await expect(
        bootstrapAdmin(ctx.app, {
          email: 'second@example.com',
          name: 'Second',
          password: 'Another-Passw0rd-2',
        }),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe('encryption key rotation CLI', () => {
    it('re-encrypts medical fields and PIN escrow to the new active key; restartable; old data still readable', async () => {
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Rotation Rider', 'Peanuts');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      await ctx
        .http()
        .put('/api/v1/customer/emergency-profile')
        .set(bearer(c.token))
        .send({
          name: 'Rotation Rider',
          bloodGroup: 'O_POSITIVE',
          allergies: ['Peanuts'],
          medicalConditions: ['Asthma'],
          emergencyNotes: 'Inhaler in jacket',
        })
        .expect(200);
      await createTestHelmet(ctx, 'SOLD'); // has a PIN escrow row

      // Same database, keyrings with a NEW active version first and the old one kept for reading.
      const rotated = await createTestApp({
        DATA_ENCRYPTION_KEYS: `v2:${key('n')},v1:${key('d')}`,
        PIN_ESCROW_KEYS: `v2:${key('m')},v1:${key('p')}`,
      });
      try {
        const before = await encryptionStatus(rotated.app);
        expect(before[0]!.activeVersion).toBe('v2');
        expect(before[0]!.versions.allergies_ciphertext).toEqual({ v1: 1 });

        const dry = await rotateEncryption(rotated.app, {
          keyring: 'data',
          batchSize: 1,
          dryRun: true,
        });
        expect(dry.reEncrypted).toBe(1);
        expect((await encryptionStatus(rotated.app))[0]!.versions.allergies_ciphertext).toEqual({
          v1: 1,
        });

        const data = await rotateEncryption(rotated.app, {
          keyring: 'data',
          batchSize: 1,
          dryRun: false,
        });
        expect(data).toMatchObject({
          activeVersion: 'v2',
          reEncrypted: 1,
          skippedConcurrentChange: 0,
        });
        const escrow = await rotateEncryption(rotated.app, {
          keyring: 'escrow',
          batchSize: 1,
          dryRun: false,
        });
        expect(escrow.reEncrypted).toBeGreaterThanOrEqual(1);

        const after = await encryptionStatus(rotated.app);
        for (const versions of Object.values(after[0]!.versions))
          if (Object.keys(versions).length > 0) expect(Object.keys(versions)).toEqual(['v2']);
        expect(after[0]!.versions.medical_conditions_ciphertext).toEqual({ v2: 1 });
        expect(Object.keys(after[1]!.versions.pin_ciphertext!)).toEqual(['v2']);

        // Idempotent: a second run finds nothing to do.
        expect(
          (await rotateEncryption(rotated.app, { keyring: 'data', batchSize: 50, dryRun: false }))
            .scanned,
        ).toBe(0);

        // The rotated app decrypts the re-encrypted profile.
        const view = await rotated
          .http()
          .get(`/api/v1/public/emergency/${c.helmet.publicToken}`)
          .expect(200);
        expect(view.body.data.profile.allergies).toEqual(['Peanuts']);
        const audit = await rotated.prisma.auditLog.findMany({
          where: { action: 'system.encryption_keys_rotated' },
        });
        expect(audit).toHaveLength(3);
        expect(JSON.stringify(audit)).not.toMatch(/Peanuts|Asthma|Inhaler/);
      } finally {
        await rotated.app.close();
      }
    });
  });
});
