import { bearer, createTestApp, newCustomer, resetState, type TestContext } from './utils';

/** Customer A must never read or change customer B's helmets, profile, contacts or settings. */
describe('Customer authorization (e2e)', () => {
  let ctx: TestContext;
  let a: { token: string; userId: string };
  let b: { token: string; userId: string };
  let bHelmetId: string;
  let bContactId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    a = await newCustomer(ctx);
    const created = await newCustomer(ctx);
    b = created;
    bHelmetId = created.helmet.id;
    await ctx
      .http()
      .put('/api/v1/customer/emergency-profile')
      .set(bearer(b.token))
      .send({ name: 'Customer B', allergies: ['B-secret-allergy'] })
      .expect(200);
    bContactId = (
      await ctx
        .http()
        .post('/api/v1/customer/emergency-contacts')
        .set(bearer(b.token))
        .send({ name: 'B Contact', relationship: 'Friend', phone: '+919812300000' })
        .expect(201)
    ).body.data.id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("cannot see or open B's helmet", async () => {
    const mine = (await ctx.http().get('/api/v1/customer/helmets').set(bearer(a.token)).expect(200))
      .body.data as { id: string }[];
    expect(mine).toHaveLength(1); // only A's own helmet (created at activation)
    expect(mine.map((h) => h.id)).not.toContain(bHelmetId);
    expect(
      (
        await ctx
          .http()
          .get(`/api/v1/customer/helmets/${bHelmetId}`)
          .set(bearer(a.token))
          .expect(404)
      ).body.error.code,
    ).toBe('HELMET_NOT_FOUND');
    await ctx
      .http()
      .get(`/api/v1/customer/helmets/${bHelmetId}/qr`)
      .set(bearer(a.token))
      .expect(404);
  });

  it('only ever reads its own profile (no user id is accepted from the client)', async () => {
    const res = await ctx
      .http()
      .get('/api/v1/customer/emergency-profile')
      .set(bearer(a.token))
      .query({ userId: b.userId })
      .expect(200);
    expect(res.body.data.name).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('B-secret-allergy');
    await ctx
      .http()
      .put('/api/v1/customer/emergency-profile')
      .set(bearer(a.token))
      .send({ userId: b.userId, name: 'hijack' })
      .expect(400);
  });

  it("cannot update or delete B's contacts", async () => {
    const upd = await ctx
      .http()
      .patch(`/api/v1/customer/emergency-contacts/${bContactId}`)
      .set(bearer(a.token))
      .send({ name: 'hijack' })
      .expect(404);
    expect(upd.body.error.code).toBe('CONTACT_NOT_FOUND');
    await ctx
      .http()
      .delete(`/api/v1/customer/emergency-contacts/${bContactId}`)
      .set(bearer(a.token))
      .expect(404);
    await ctx
      .http()
      .put('/api/v1/customer/emergency-contacts/order')
      .set(bearer(a.token))
      .send({ ids: [bContactId] })
      .expect(400);
    const contact = await ctx.prisma.emergencyContact.findUniqueOrThrow({
      where: { id: bContactId },
    });
    expect(contact).toMatchObject({ name: 'B Contact', isActive: true });
  });

  it("cannot change B's settings or sessions", async () => {
    await ctx
      .http()
      .put('/api/v1/customer/emergency-visibility')
      .set(bearer(a.token))
      .send({
        showName: true,
        showPhoto: true,
        showBloodGroup: true,
        showDateOfBirth: true,
        showGender: true,
        showAllergies: true,
        showMedicalConditions: true,
        showMedications: true,
        showEmergencyNotes: true,
        showOrganDonor: true,
        showEmergencyContacts: true,
      })
      .expect(200);
    expect(
      await ctx.prisma.emergencyVisibility.findUnique({ where: { userId: b.userId } }),
    ).toBeNull();
    const bSessions = await ctx.prisma.customerRefreshToken.findFirstOrThrow({
      where: { userId: b.userId },
    });
    await ctx
      .http()
      .delete(`/api/v1/customer/auth/sessions/${bSessions.familyId}`)
      .set(bearer(a.token))
      .expect(404);
    expect(
      (await ctx.prisma.customerRefreshToken.findUniqueOrThrow({ where: { id: bSessions.id } }))
        .revokedAt,
    ).toBeNull();
  });

  it('requires authentication on every customer route', async () => {
    for (const path of [
      '/api/v1/customer/helmets',
      '/api/v1/customer/emergency-profile',
      '/api/v1/customer/emergency-contacts',
      '/api/v1/customer/emergency-visibility',
      '/api/v1/customer/dashboard',
    ]) {
      await ctx.http().get(path).expect(401);
    }
  });
});
