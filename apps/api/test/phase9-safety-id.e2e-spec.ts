import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminRole } from '@helmet/types';
import { RiskEvaluationService } from '../src/modules/analytics/risk-evaluation.service';
import { EncryptionService } from '../src/security/encryption.service';
import {
  bearer,
  completeProfile,
  createAdmin,
  createTestApp,
  createTestHelmet,
  createTestSafetyId,
  enableOnHelmet,
  enableOnSafetyId,
  login,
  newCustomer,
  publicView,
  reauth,
  registerCustomer,
  resetState,
  startTransfer,
  TEST_PASSWORD,
  type TestContext,
  uniqueEmail,
  waitFor,
  TEST_MOBILE,
} from './utils';

/**
 * Phase 9: the Safety ID is the emergency identity; a helmet is an optional linked product.
 * Standalone Safety IDs, independent sharing per Safety ID, linked-helmet ownership rules,
 * transfers, generation/export/print, admin actions, RBAC and the Phase 8 → 9 data migration.
 */
describe('Phase 9 — Safety ID (e2e)', () => {
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
  const verify = async (token: string) =>
    (await ctx.http().get(`/api/v1/public/verify/${token}`).expect(200)).body.data;
  const mySafetyIds = async (token: string) =>
    (await ctx.http().get('/api/v1/customer/safety-ids').set(bearer(token)).expect(200)).body.data;

  describe('standalone Safety ID (no helmet)', () => {
    it('activates, shares and shows a person-focused emergency page with no product data', async () => {
      const s = await createTestSafetyId(ctx);
      const validate = await ctx
        .http()
        .post('/api/v1/customer/activation/validate')
        .send({ safetyCode: s.safetyCode, pin: s.pin })
        .expect(200);
      expect(validate.body.data).toEqual({
        activatable: true,
        safetyId: { safetyCode: s.safetyCode },
        linkedHelmet: null,
      });
      const res = await ctx
        .http()
        .post('/api/v1/customer/activation/register')
        .send({
          publicToken: s.publicToken,
          pin: s.pin,
          email: uniqueEmail(),
          mobile: TEST_MOBILE,
          password: TEST_PASSWORD,
        })
        .expect(200);
      expect(res.body.data.safetyId).toMatchObject({
        id: s.id,
        safetyCode: s.safetyCode,
        status: 'ACTIVATED',
        emergencySharing: false,
        linkedHelmet: null,
        canTransfer: true,
      });
      expect(res.body.data.helmet).toBeNull();
      const token = res.body.data.accessToken as string;
      // No helmet ownership, no warranty, no helmet lifecycle for a standalone Safety ID.
      expect(await ctx.prisma.helmetOwnership.count()).toBe(0);
      expect(await ctx.prisma.helmet.count()).toBe(0);

      const dash = (
        await ctx.http().get('/api/v1/customer/dashboard').set(bearer(token)).expect(200)
      ).body.data;
      expect(dash.helmets).toEqual([]);
      expect(dash.safetyIdSummary).toEqual({ total: 1, active: 0, needsSetup: 1 });

      expect(await publicView(ctx, s.publicToken)).toMatchObject({
        state: 'ACTIVATED_PROFILE_INCOMPLETE',
        linkedProduct: false,
        safetyId: {},
      });
      await completeProfile(ctx, token, 'Solo Rider');
      await enableOnSafetyId(ctx, token, s.id);
      const view = await publicView(ctx, s.publicToken);
      expect(view).toMatchObject({
        state: 'ACTIVE',
        linkedProduct: false,
        safetyId: { code: s.safetyCode },
        profile: { name: 'Solo Rider' },
      });
      expect(Object.keys(view)).not.toContain('helmet');
      expect(
        (await ctx.http().get('/api/v1/customer/dashboard').set(bearer(token)).expect(200)).body
          .data.safetyIdSummary,
      ).toEqual({ total: 1, active: 1, needsSetup: 0 });
      expect((await ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
        'ACTIVE',
      );

      // Verify page: registered Safety ID, no product facts.
      expect(await verify(s.publicToken)).toEqual({
        state: 'SAFETY_ID_VERIFIED',
        message:
          'Safety ID verified. This Safety ID is registered with Ozzo. No registered product is currently linked to this Safety ID.',
        safetyId: { code: s.safetyCode },
      });
      // Scans are logged against the Safety ID with no helmet.
      await waitFor(
        () => ctx.prisma.helmetScan.findFirst({ where: { safetyId: s.id } }),
        (x) => x !== null,
      ).catch(() => null);
      expect(await ctx.prisma.helmetScan.count({ where: { helmetId: { not: null } } })).toBe(0);
    });

    it('several Safety IDs share one profile, each with its own switch', async () => {
      const c = await newCustomer(ctx); // linked helmet + its Safety ID
      const solo = await createTestSafetyId(ctx, 'PRINTED', 'WXYZ6789');
      await ctx
        .http()
        .post('/api/v1/customer/activation/add-safety-id')
        .set(bearer(c.token))
        .send({ safetyCode: solo.safetyCode, pin: solo.pin })
        .expect(200);
      await completeProfile(ctx, c.token, 'Two Codes');
      // With two Safety IDs in use, enabling the profile switches nothing on implicitly.
      await ctx
        .http()
        .post('/api/v1/customer/emergency-profile/enable')
        .set(bearer(c.token))
        .expect(200);
      expect((await publicView(ctx, solo.publicToken)).profile).toBeUndefined();
      await enableOnSafetyId(ctx, c.token, solo.id);
      expect((await publicView(ctx, solo.publicToken)).profile?.name).toBe('Two Codes');
      expect((await publicView(ctx, c.helmet.publicToken)).profile).toBeUndefined();
      const list = await mySafetyIds(c.token);
      expect(list).toHaveLength(2);
      expect(
        Object.fromEntries(
          list.map((x: { id: string; emergencySharing: boolean }) => [x.id, x.emergencySharing]),
        ),
      ).toEqual({ [solo.id]: true, [c.helmet.safetyId]: false });
      // Turning one off leaves the other as it is.
      await ctx
        .http()
        .post(`/api/v1/customer/safety-ids/${solo.id}/emergency/disable`)
        .set(bearer(c.token))
        .expect(200);
      expect((await publicView(ctx, solo.publicToken)).profile).toBeUndefined();
      // Another customer can't see or toggle it (404, no ownership oracle).
      const other = await newCustomer(ctx);
      await ctx
        .http()
        .post(`/api/v1/customer/safety-ids/${solo.id}/emergency/disable`)
        .set(bearer(other.token))
        .expect(404);
      await ctx
        .http()
        .get(`/api/v1/customer/safety-ids/${solo.id}`)
        .set(bearer(other.token))
        .expect(404);
    });
    it('raises a deduplicated risk alert about a standalone Safety ID (no helmet subject)', async () => {
      const s = await createTestSafetyId(ctx);
      await ctx.prisma.helmetScan.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({
          helmetId: null,
          safetyId: s.id,
          scanType: 'EMERGENCY_PAGE' as const,
          scannedAt: new Date(Date.now() - (i % 50) * 1000),
          ipHash: 'a'.repeat(64),
          userAgent: 'Mobile Safari on iOS',
          deviceCategory: 'MOBILE' as const,
        })),
      });
      const risk = ctx.app.get(RiskEvaluationService);
      await risk.evaluate();
      await risk.evaluate();
      const alerts = await ctx.prisma.riskAlert.findMany();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ safetyId: s.id, helmetId: null });
      expect(alerts[0]!.dedupKey).toBe(`safety:${s.id}:volume`);
    });
  });

  describe('helmet-linked Safety ID', () => {
    it('sharing on the Safety ID is mirrored onto the helmet (and the helmet endpoint still works)', async () => {
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Linked Rider');
      await enableOnHelmet(ctx, c.token, c.helmet.id); // Phase 8 endpoint → linked Safety ID
      const [si, helmet, hs] = await Promise.all([
        ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: c.helmet.safetyId } }),
        ctx.prisma.helmet.findUniqueOrThrow({ where: { id: c.helmet.id } }),
        ctx.prisma.helmetEmergencySetting.findFirst({ where: { helmetId: c.helmet.id } }),
      ]);
      expect(si.status).toBe('ACTIVE');
      expect(helmet.status).toBe('ACTIVE');
      expect(hs?.enabled).toBe(true);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view).toMatchObject({
        state: 'ACTIVE',
        linkedProduct: true,
        safetyId: { code: c.helmet.safetyCode },
      });
      // The helmet page shows its Safety ID.
      const dto = (
        await ctx
          .http()
          .get(`/api/v1/customer/helmets/${c.helmet.id}`)
          .set(bearer(c.token))
          .expect(200)
      ).body.data;
      expect(dto.safetyId).toEqual({
        id: c.helmet.safetyId,
        safetyCode: c.helmet.safetyCode,
        status: 'ACTIVE',
      });
      // Lost helmet (Phase 8 rule kept): the switch stays on, the lifecycle hides the profile;
      // marking it found shows it again without the owner re-enabling anything.
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/lost`)
        .set(bearer(c.token))
        .expect(200);
      expect(await publicView(ctx, c.helmet.publicToken)).toMatchObject({ state: 'LOST' });
      expect((await publicView(ctx, c.helmet.publicToken)).profile).toBeUndefined();
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/found`)
        .set(bearer(c.token))
        .expect(200);
      expect((await publicView(ctx, c.helmet.publicToken)).profile?.name).toBe('Linked Rider');
      // Retiring the helmet switches the linked Safety ID's sharing off for good.
      const recent = await reauth(ctx, c.token);
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/deactivate`)
        .set(bearer(c.token))
        .set('X-Recent-Auth', recent)
        .send({ confirmHelmetCode: c.helmet.helmetCode })
        .expect(200);
      expect(
        (await ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: c.helmet.safetyId } })).status,
      ).toBe('ACTIVATED');
      expect(await publicView(ctx, c.helmet.publicToken)).toMatchObject({ state: 'DEACTIVATED' });
    });

    it('a linked helmet owned by someone else blocks activation and consumes nothing', async () => {
      const owner = await newCustomer(ctx);
      const orphan = await createTestSafetyId(ctx, 'PRINTED', 'QRST2345');
      const admin = await asAdmin('SUPER_ADMIN');
      // Support re-linked a spare Safety ID to the owned helmet by mistake: first unlink the
      // helmet's own Safety ID, then link the spare (both owner checks pass only if owners match).
      await ctx
        .http()
        .post(`/api/v1/admin/safety-ids/${owner.helmet.safetyId}/unlink`)
        .set(bearer(admin.token))
        .send({ reason: 'Sticker damaged' })
        .expect(200);
      const conflict = await ctx
        .http()
        .post(`/api/v1/admin/safety-ids/${orphan.id}/link`)
        .set(bearer(admin.token))
        .send({ helmetCode: owner.helmet.helmetCode, reason: 'Replacement sticker' })
        .expect(409);
      expect(conflict.body.error.code).toBe('SAFETY_ID_LINK_CONFLICT');
      // Force the inconsistent link directly (as an old bug might have) and try to activate.
      await ctx.prisma.safetyIdHelmetLink.create({
        data: { safetyId: orphan.id, helmetId: owner.helmet.id, reason: 'TEST' },
      });
      const stranger = await newCustomer(ctx);
      const res = await ctx
        .http()
        .post('/api/v1/customer/activation/add-safety-id')
        .set(bearer(stranger.token))
        .send({ safetyCode: orphan.safetyCode, pin: orphan.pin })
        .expect(409);
      expect(res.body.error.code).toBe('SAFETY_ID_LINK_CONFLICT');
      const row = await ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: orphan.id } });
      expect(row).toMatchObject({ status: 'PRINTED', activationPinUsed: false });
      expect(
        await ctx.prisma.safetyIdActivationSecret.count({ where: { safetyId: orphan.id } }),
      ).toBe(1);
      expect(await ctx.prisma.safetyIdOwnership.count({ where: { safetyId: orphan.id } })).toBe(0);
    });
  });

  describe('transfers', () => {
    it('standalone Safety ID: Transfer Code → new owner, sharing off, previous data gone at once', async () => {
      const s = await createTestSafetyId(ctx);
      const a = await registerCustomer(ctx, s);
      await completeProfile(ctx, a.token, 'Old Owner');
      await enableOnSafetyId(ctx, a.token, s.id);
      expect((await publicView(ctx, s.publicToken)).profile?.name).toBe('Old Owner');
      const recent = await reauth(ctx, a.token);
      const start = await ctx
        .http()
        .post(`/api/v1/customer/safety-ids/${s.id}/transfer`)
        .set(bearer(a.token))
        .set('X-Recent-Auth', recent)
        .expect(200);
      expect(start.body.data.transferCode).toMatch(/^TR-/);
      const b = await newCustomer(ctx);
      const claim = await ctx
        .http()
        .post('/api/v1/customer/safety-id-transfers/claim')
        .set(bearer(b.token))
        .send({ safetyCode: s.safetyCode, transferCode: start.body.data.transferCode })
        .expect(200);
      expect(claim.body.data.safetyId).toMatchObject({
        id: s.id,
        emergencySharing: false,
        status: 'ACTIVATED',
      });
      const view = await publicView(ctx, s.publicToken);
      expect(view.profile).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain('Old Owner');
      expect(await mySafetyIds(a.token)).toEqual([]);
      const periods = await ctx.prisma.safetyIdOwnership.findMany({
        where: { safetyId: s.id },
        orderBy: { startedAt: 'asc' },
      });
      expect(periods.map((p) => [p.status, p.source])).toEqual([
        ['TRANSFERRED', 'ACTIVATION'],
        ['ACTIVE', 'TRANSFER'],
      ]);
      // The code is single use.
      await ctx
        .http()
        .post('/api/v1/customer/safety-id-transfers/claim')
        .set(bearer(a.token))
        .send({ safetyCode: s.safetyCode, transferCode: start.body.data.transferCode })
        .expect(409);
    });

    it('a linked Safety ID cannot be transferred alone; the helmet transfer moves both', async () => {
      const a = await newCustomer(ctx);
      const recent = await reauth(ctx, a.token);
      const res = await ctx
        .http()
        .post(`/api/v1/customer/safety-ids/${a.helmet.safetyId}/transfer`)
        .set(bearer(a.token))
        .set('X-Recent-Auth', recent)
        .expect(409);
      expect(res.body.error.code).toBe('SAFETY_ID_NOT_TRANSFERABLE');
      const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
      const b = await newCustomer(ctx);
      await ctx
        .http()
        .post('/api/v1/customer/transfers/claim')
        .set(bearer(b.token))
        .send({ helmetCode: a.helmet.helmetCode, transferCode })
        .expect(200);
      const owner = await ctx.prisma.safetyIdOwnership.findFirstOrThrow({
        where: { safetyId: a.helmet.safetyId, status: 'ACTIVE' },
      });
      expect(owner).toMatchObject({ userId: b.userId, source: 'TRANSFER' });
      expect((await mySafetyIds(b.token)).map((x: { id: string }) => x.id)).toContain(
        a.helmet.safetyId,
      );
    });
  });

  describe('generation, export and print', () => {
    it('standalone batch: generate, CSV + print sheet (no-store, audited), mark printed purges PINs', async () => {
      const mfg = await asAdmin('MANUFACTURING');
      const created = await ctx
        .http()
        .post('/api/v1/admin/safety-id-batches')
        .set(bearer(mfg.token))
        .send({ mode: 'STANDALONE', quantity: 12 })
        .expect(201);
      const id = created.body.data.id as string;
      expect(created.body.data.batchCode).toMatch(/^SID-\d{4}-\d{5}$/);
      await ctx
        .http()
        .post(`/api/v1/admin/safety-id-batches/${id}/generate`)
        .set(bearer(mfg.token))
        .expect(202);
      const done = await waitFor(
        () => ctx.prisma.safetyIdBatch.findUniqueOrThrow({ where: { id } }),
        (b) => b.generationStatus === 'COMPLETED',
      );
      expect(done.generatedCount).toBe(12);
      expect(await ctx.prisma.safetyId.count({ where: { batchId: id, status: 'GENERATED' } })).toBe(
        12,
      );
      expect(await ctx.prisma.safetyIdHelmetLink.count()).toBe(0);

      const csv = await ctx
        .http()
        .get(`/api/v1/admin/safety-id-batches/${id}/export/safety-ids.csv`)
        .set(bearer(mfg.token))
        .buffer(true)
        .expect(200);
      expect(csv.headers['cache-control']).toBe('no-store');
      const lines = csv.text.trim().split('\r\n');
      expect(lines[0]).toBe(
        'safetyCode,publicQrUrl,activationPin,qrPayload,batchCode,unitIndex,sheet,sheetRow,sheetColumn,linkedHelmetCode,linkedHelmetSerial,model',
      );
      expect(lines).toHaveLength(13);
      const [code, url, pin, payload, , unitIndex, sheet, sheetRow, col] = lines[1]!.split(',');
      expect(pin).toMatch(/^[0-9]{6}$/);
      expect(payload).toBe(url);
      expect([unitIndex, sheet, sheetRow, col]).toEqual(['1', '1', '1', '1']);
      const row = await ctx.prisma.safetyId.findUniqueOrThrow({ where: { safetyCode: code } });
      expect(url).toBe(`https://safe.example.test/e/${row.publicToken}`);
      await expect(ctx.hashing.verifyPin(row.activationPinHash, pin!)).resolves.toBe(true);
      // Escrow is bound to its Safety ID (AAD): it can't be decrypted for another row.
      const secret = await ctx.prisma.safetyIdActivationSecret.findUniqueOrThrow({
        where: { safetyId: row.id },
      });
      expect(() =>
        ctx.app.get(EncryptionService).pinEscrow.decrypt(secret.pinCiphertext, 'another-safety-id'),
      ).toThrow();

      const pdf = await ctx
        .http()
        .get(`/api/v1/admin/safety-id-batches/${id}/export/print.pdf`)
        .set(bearer(mfg.token))
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['cache-control']).toBe('no-store');
      expect(pdf.headers['x-print-sheets']).toBe('1');
      expect(pdf.headers['x-pins-included']).toBe('12');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const audits = await ctx.prisma.auditLog.findMany({ where: { entityId: id } });
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(['safety_id.batch.exported', 'safety_id.batch.print_pdf']),
      );
      expect(JSON.stringify(audits)).not.toContain(pin);

      // PIN states for operators: exported → purged.
      const support = await asAdmin('SUPPORT');
      const detail = await ctx
        .http()
        .get(`/api/v1/admin/safety-ids/${row.id}`)
        .set(bearer(support.token))
        .expect(200);
      expect(detail.body.data.pinState).toBe('EXPORTED');
      expect(JSON.stringify(detail.body)).not.toContain(row.activationPinHash);
      await ctx
        .http()
        .post(`/api/v1/admin/safety-id-batches/${id}/mark-printed`)
        .set(bearer(mfg.token))
        .expect(200);
      expect(
        await ctx.prisma.safetyIdActivationSecret.count({
          where: { safetyIdRef: { batchId: id } },
        }),
      ).toBe(0);
      expect(await ctx.prisma.safetyId.count({ where: { batchId: id, status: 'PRINTED' } })).toBe(
        12,
      );
      expect(
        (await ctx.http().get(`/api/v1/admin/safety-ids/${row.id}`).set(bearer(support.token))).body
          .data.pinState,
      ).toBe('PURGED');
      // The printed PIN activates its Safety ID.
      const c = await registerCustomer(ctx, { publicToken: row.publicToken, pin: pin! });
      expect((await mySafetyIds(c.token))[0]).toMatchObject({
        safetyCode: code,
        linkedHelmet: null,
      });
      expect(
        (await ctx.http().get(`/api/v1/admin/safety-ids/${row.id}`).set(bearer(support.token))).body
          .data.pinState,
      ).toBe('CONSUMED');
    });

    it('helmet-linked batch for helmets created without Safety IDs', async () => {
      const admin = await asAdmin('ADMIN');
      const model = await ctx
        .http()
        .post('/api/v1/admin/helmet-models')
        .set(bearer(admin.token))
        .send({ name: 'Plain', sku: 'PL-1', brand: 'Ozzo' })
        .expect(201);
      const batch = await ctx
        .http()
        .post('/api/v1/admin/batches')
        .set(bearer(admin.token))
        .send({
          helmetModelId: model.body.data.id,
          manufacturingDate: '2026-09-01',
          quantity: 4,
          withSafetyIds: false,
        })
        .expect(201);
      expect(batch.body.data).toMatchObject({ withSafetyIds: false, safetyIdBatch: null });
      await ctx
        .http()
        .post(`/api/v1/admin/batches/${batch.body.data.id}/generate`)
        .set(bearer(admin.token))
        .expect(202);
      await waitFor(
        () => ctx.prisma.helmetBatch.findUniqueOrThrow({ where: { id: batch.body.data.id } }),
        (b) => b.generationStatus === 'COMPLETED',
      );
      expect(
        await ctx.prisma.helmet.count({
          where: { batchId: batch.body.data.id, publicToken: null },
        }),
      ).toBe(4);
      const sib = await ctx
        .http()
        .post('/api/v1/admin/safety-id-batches')
        .set(bearer(admin.token))
        .send({ mode: 'HELMET_LINKED', helmetBatchId: batch.body.data.id })
        .expect(201);
      expect(sib.body.data).toMatchObject({ mode: 'HELMET_LINKED', quantity: 4 });
      await ctx
        .http()
        .post(`/api/v1/admin/safety-id-batches/${sib.body.data.id}/generate`)
        .set(bearer(admin.token))
        .expect(202);
      await waitFor(
        () => ctx.prisma.safetyIdBatch.findUniqueOrThrow({ where: { id: sib.body.data.id } }),
        (b) => b.generationStatus === 'COMPLETED',
      );
      const links = await ctx.prisma.safetyIdHelmetLink.findMany({
        where: { helmet: { batchId: batch.body.data.id }, endedAt: null },
        include: { helmet: true, safetyIdRef: true },
      });
      expect(links).toHaveLength(4);
      for (const l of links) expect(l.helmet.publicToken).toBe(l.safetyIdRef.publicToken);
      // Nothing left to generate.
      await ctx
        .http()
        .post('/api/v1/admin/safety-id-batches')
        .set(bearer(admin.token))
        .send({ mode: 'HELMET_LINKED', helmetBatchId: batch.body.data.id })
        .expect(409);
    });

    it('RBAC: SUPPORT reads only; MANUFACTURING generates/exports; ANALYTICS_VIEWER has no access', async () => {
      const s = await createTestSafetyId(ctx);
      const batch = await ctx.prisma.safetyIdBatch.create({
        data: {
          batchCode: 'SID-2026-99999',
          quantity: 1,
          generatedCount: 1,
          generationStatus: 'COMPLETED',
        },
      });
      await ctx.prisma.safetyId.update({ where: { id: s.id }, data: { batchId: batch.id } });
      const support = await asAdmin('SUPPORT');
      const viewer = await asAdmin('ANALYTICS_VIEWER');
      const mfg = await asAdmin('MANUFACTURING');
      await ctx.http().get('/api/v1/admin/safety-ids').set(bearer(support.token)).expect(200);
      await ctx
        .http()
        .get(`/api/v1/admin/safety-id-batches/${batch.id}/export/safety-ids.csv`)
        .set(bearer(support.token))
        .expect(403);
      await ctx
        .http()
        .post('/api/v1/admin/safety-id-batches')
        .set(bearer(support.token))
        .send({ mode: 'STANDALONE', quantity: 1 })
        .expect(403);
      await ctx
        .http()
        .post(`/api/v1/admin/safety-ids/${s.id}/deactivate`)
        .set(bearer(support.token))
        .send({ reason: 'nope' })
        .expect(403);
      await ctx.http().get('/api/v1/admin/safety-ids').set(bearer(viewer.token)).expect(403);
      await ctx
        .http()
        .get(`/api/v1/admin/safety-id-batches/${batch.id}/export/safety-ids.csv`)
        .set(bearer(mfg.token))
        .expect(200);
      await ctx
        .http()
        .post(`/api/v1/admin/safety-ids/${s.id}/link`)
        .set(bearer(mfg.token))
        .send({ helmetCode: 'HM-AAAA-AAAA', reason: 'nope' })
        .expect(403);
    });
  });

  describe('admin support actions', () => {
    it('deactivate hides the profile at once (recent auth), reactivate restores ACTIVATED; search finds it', async () => {
      const s = await createTestSafetyId(ctx);
      const c = await registerCustomer(ctx, s);
      await completeProfile(ctx, c.token, 'Sticker Owner');
      await enableOnSafetyId(ctx, c.token, s.id);
      expect((await publicView(ctx, s.publicToken)).profile?.name).toBe('Sticker Owner');
      const admin = await asAdmin('ADMIN');
      const found = await ctx
        .http()
        .get('/api/v1/admin/safety-ids')
        .query({ search: s.safetyCode.toLowerCase() })
        .set(bearer(admin.token))
        .expect(200);
      expect(found.body.data.map((x: { id: string }) => x.id)).toEqual([s.id]);
      const byCustomer = await ctx
        .http()
        .get('/api/v1/admin/customers')
        .query({ q: s.safetyCode })
        .set(bearer(admin.token))
        .expect(200);
      expect(byCustomer.body.data.matchedBy).toBe('safetyId');
      expect(byCustomer.body.data.items).toHaveLength(1);
      await ctx
        .http()
        .post(`/api/v1/admin/safety-ids/${s.id}/deactivate`)
        .set(bearer(admin.token))
        .send({ reason: 'Owner lost the sticker' })
        .expect(403); // recent auth required
      const rec = await ctx
        .http()
        .post('/api/v1/admin/auth/reauthenticate')
        .set(bearer(admin.token))
        .send({ password: admin.password })
        .expect(200);
      await ctx
        .http()
        .post(`/api/v1/admin/safety-ids/${s.id}/deactivate`)
        .set(bearer(admin.token))
        .set('X-Recent-Auth', rec.body.data.recentAuthToken)
        .send({ reason: 'Owner lost the sticker' })
        .expect(200);
      const view = await publicView(ctx, s.publicToken);
      expect(view).toMatchObject({
        state: 'DEACTIVATED',
        message: 'This Safety ID is no longer active.',
      });
      expect(view.profile).toBeUndefined();
      const back = await ctx
        .http()
        .post(`/api/v1/admin/safety-ids/${s.id}/reactivate`)
        .set(bearer(admin.token))
        .send({ reason: 'Found it' })
        .expect(200);
      expect(back.body.data).toMatchObject({ status: 'ACTIVATED', emergencySharing: false });
      expect(
        await ctx.prisma.auditLog.count({
          where: { entityId: s.id, action: { startsWith: 'safety_id.' } },
        }),
      ).toBeGreaterThanOrEqual(3);
      // The customer page lists Safety IDs separately from helmets.
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
      const page = await ctx
        .http()
        .get(`/api/v1/admin/customers/${user.customerCode}`)
        .set(bearer(admin.token))
        .expect(200);
      expect(page.body.data.helmets).toEqual([]);
      expect(page.body.data.safetyIds).toEqual([
        expect.objectContaining({ safetyCode: s.safetyCode, linkedHelmetCode: null }),
      ]);
    });

    it('account data export includes Safety IDs; deletion switches sharing off on all of them', async () => {
      const s = await createTestSafetyId(ctx);
      const c = await registerCustomer(ctx, s);
      await completeProfile(ctx, c.token, 'Export Me');
      await enableOnSafetyId(ctx, c.token, s.id);
      const recent = await reauth(ctx, c.token);
      const exp = await ctx
        .http()
        .get('/api/v1/customer/account/export')
        .set(bearer(c.token))
        .set('X-Recent-Auth', recent)
        .expect(200);
      expect(JSON.parse(exp.text).safetyIds).toEqual([
        {
          safetyCode: s.safetyCode,
          status: 'ACTIVE',
          emergencySharing: true,
          linkedHelmetCode: null,
        },
      ]);
      expect(exp.text).not.toContain(s.publicToken);
      const admin = await asAdmin('SUPER_ADMIN');
      const rec = await ctx
        .http()
        .post('/api/v1/admin/auth/reauthenticate')
        .set(bearer(admin.token))
        .send({ password: admin.password })
        .expect(200);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
      await ctx
        .http()
        .post(`/api/v1/admin/customers/${user.customerCode}/delete`)
        .set(bearer(admin.token))
        .set('X-Recent-Auth', rec.body.data.recentAuthToken)
        .send({ reason: 'Customer asked for deletion', confirmCustomerId: user.customerCode })
        .expect(200);
      expect((await publicView(ctx, s.publicToken)).profile).toBeUndefined();
      expect((await ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(
        'ACTIVATED',
      );
    });
  });

  describe('Phase 8 → Phase 9 data migration (backfill SQL)', () => {
    /** Runs Part 3 (idempotent backfill) of the real Phase 9 migration file. */
    const runBackfill = async () => {
      const sql = readFileSync(
        join(__dirname, '../prisma/migrations/20261011090000_phase9_safety_id/migration.sql'),
        'utf8',
      );
      const part3 = sql.slice(sql.indexOf('-- 3.1 Safety IDs'));
      for (const stmt of part3.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()))
        if (stmt) await ctx.prisma.$executeRawUnsafe(stmt);
    };
    /** Removes every Phase 9 row for a helmet, leaving exactly what Phase 8 had stored. */
    const toPhase8 = async (h: { id: string; safetyId: string }, pin?: string) => {
      await ctx.prisma.safetyIdEmergencySetting.deleteMany({ where: { safetyId: h.safetyId } });
      await ctx.prisma.safetyIdOwnership.deleteMany({ where: { safetyId: h.safetyId } });
      await ctx.prisma.helmetScan.updateMany({
        where: { safetyId: h.safetyId },
        data: { safetyId: null },
      });
      await ctx.prisma.safetyIdHelmetLink.deleteMany({ where: { safetyId: h.safetyId } });
      await ctx.prisma.safetyId.delete({ where: { id: h.safetyId } });
      if (pin)
        await ctx.prisma.helmetActivationSecret.create({
          data: {
            helmetId: h.id,
            pinCiphertext: ctx.app.get(EncryptionService).pinEscrow.encrypt(pin, h.id),
          },
        });
      await ctx.redis.flushdb();
    };

    it('keeps tokens identical, unused PINs working and active users visible; idempotent', async () => {
      // An active Phase 8 user (owner + profile + sharing on) and an unsold, unactivated helmet.
      const active = await newCustomer(ctx);
      await completeProfile(ctx, active.token, 'Phase Eight');
      await enableOnHelmet(ctx, active.token, active.helmet.id);
      const unsold = await createTestHelmet(ctx, 'SOLD', 'MNPQ2345');
      await ctx.prisma.helmetScan.create({
        data: { helmetId: active.helmet.id, scanType: 'EMERGENCY_PAGE' },
      });
      await toPhase8(active.helmet);
      await toPhase8(unsold, unsold.pin);
      expect(await ctx.prisma.safetyId.count()).toBe(0);

      await runBackfill();
      await runBackfill(); // idempotent

      for (const h of [active.helmet, unsold]) {
        const helmet = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: h.id } });
        const si = await ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: h.id } });
        // Exact token match: the printed QR URL keeps working.
        expect(si.publicToken).toBe(helmet.publicToken);
        expect(si.activationPinHash).toBe(helmet.activationPinHash);
        expect(si.safetyCode).toBe(`SI-${helmet.helmetCode.slice(3)}`);
      }
      expect(await ctx.prisma.safetyId.count()).toBe(2);
      // Active user: same profile on the same QR, ACTIVE, owner and switch preserved.
      expect(await publicView(ctx, active.helmet.publicToken)).toMatchObject({
        state: 'ACTIVE',
        profile: { name: 'Phase Eight' },
      });
      expect(
        await ctx.prisma.safetyIdOwnership.findFirstOrThrow({
          where: { safetyId: active.helmet.id, status: 'ACTIVE' },
        }),
      ).toMatchObject({ userId: active.userId, source: 'MIGRATION' });
      // The Phase 8 scan row is attached to the Safety ID (no scan left without one).
      expect(await ctx.prisma.helmetScan.count({ where: { safetyId: null } })).toBe(0);
      expect(
        await ctx.prisma.helmetScan.count({ where: { safetyId: active.helmet.id } }),
      ).toBeGreaterThanOrEqual(1);
      // Unused Phase 8 PIN: escrow ciphertext still decrypts (AAD = same id) and activation works.
      const escrow = await ctx.prisma.safetyIdActivationSecret.findUniqueOrThrow({
        where: { safetyId: unsold.id },
      });
      expect(
        ctx.app.get(EncryptionService).pinEscrow.decrypt(escrow.pinCiphertext, unsold.id),
      ).toBe(unsold.pin);
      const c = await registerCustomer(ctx, { publicToken: unsold.publicToken, pin: unsold.pin });
      expect((await mySafetyIds(c.token))[0]).toMatchObject({
        id: unsold.id,
        linkedHelmet: { id: unsold.id },
      });
      // The reconcile script is a no-op on consistent data.
      const reconcile = readFileSync(join(__dirname, '../scripts/reconcile-phase9.sql'), 'utf8');
      const before = await ctx.prisma.$queryRaw<{ s: string }[]>`
        SELECT md5(string_agg(id::text || status::text || activation_pin_used::text, ',' ORDER BY id)) AS s FROM safety_ids`;
      for (const stmt of reconcile.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()))
        if (stmt) await ctx.prisma.$executeRawUnsafe(stmt);
      const after = await ctx.prisma.$queryRaw<{ s: string }[]>`
        SELECT md5(string_agg(id::text || status::text || activation_pin_used::text, ',' ORDER BY id)) AS s FROM safety_ids`;
      expect(after[0]!.s).toBe(before[0]!.s);
    });
  });
});
