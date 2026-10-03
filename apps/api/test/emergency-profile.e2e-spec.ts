import sharp from 'sharp';
import {
  bearer,
  createAdmin,
  createTestApp,
  createTestHelmet,
  login,
  registerCustomer,
  resetState,
  type TestContext,
} from './utils';

const ALL_HIDDEN = {
  showName: false,
  showPhoto: false,
  showBloodGroup: false,
  showDateOfBirth: false,
  showGender: false,
  showAllergies: false,
  showMedicalConditions: false,
  showMedications: false,
  showEmergencyNotes: false,
  showOrganDonor: false,
  showEmergencyContacts: false,
};

describe('Emergency profile & public boundary (e2e)', () => {
  let ctx: TestContext;
  let token: string;
  let userId: string;
  let helmet: Awaited<ReturnType<typeof createTestHelmet>>;
  const pub = () => ctx.http().get(`/api/v1/public/emergency/${helmet.publicToken}`).expect(200);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    helmet = await createTestHelmet(ctx, 'SOLD');
    const session = await registerCustomer(ctx, helmet);
    token = session.token;
    userId = session.userId;
    // Optional, unverified contact number (used below to check admin masking).
    await ctx
      .http()
      .patch('/api/v1/customer/auth/me')
      .set(bearer(token))
      .send({ mobile: '+919876511111' })
      .expect(200);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('starts with nothing configured and everything hidden', async () => {
    const vis = await ctx
      .http()
      .get('/api/v1/customer/emergency-visibility')
      .set(bearer(token))
      .expect(200);
    expect(vis.body.data).toEqual({ ...ALL_HIDDEN, confirmedAt: null });
    const readiness = await ctx
      .http()
      .get('/api/v1/customer/emergency-profile/readiness')
      .set(bearer(token))
      .expect(200);
    expect(readiness.body.data).toMatchObject({
      status: 'NOT_CONFIGURED',
      canEnable: false,
      completionPercent: 20,
      missing: ['NAME', 'EMERGENCY_CONTACT', 'PRIVACY_REVIEW'],
    });
  });

  it('creates/updates the profile and encrypts medical fields at rest', async () => {
    const res = await ctx
      .http()
      .put('/api/v1/customer/emergency-profile')
      .set(bearer(token))
      .send({
        name: 'Rahul Sharma',
        bloodGroup: 'O_POSITIVE',
        dateOfBirth: '1990-05-14',
        gender: 'MALE',
        allergies: ['Penicillin', ' penicillin ', 'Peanuts'],
        medicalConditions: ['Asthma'],
        medications: ['Salbutamol'],
        emergencyNotes: 'Inhaler in jacket pocket',
        organDonor: true,
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      name: 'Rahul Sharma',
      allergies: ['Penicillin', 'Peanuts'],
      emergencyNotes: 'Inhaler in jacket pocket',
      emergencyProfileEnabled: false,
    });

    const row = await ctx.prisma.emergencyProfile.findFirstOrThrow({ where: { userId } });
    const raw = JSON.stringify(row);
    for (const secret of ['Penicillin', 'Asthma', 'Salbutamol', 'Inhaler', '1990-05-14'])
      expect(raw).not.toContain(secret);
    expect(row.allergiesCiphertext).toMatch(/^v1\./);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'emergency_profile.updated', userId },
    });
    expect(audit.metadata).toMatchObject({
      changedFields: expect.arrayContaining(['allergies', 'name']),
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Penicillin|Asthma|Inhaler/);

    // Partial update leaves other fields untouched; null clears.
    const partial = await ctx
      .http()
      .put('/api/v1/customer/emergency-profile')
      .set(bearer(token))
      .send({ gender: null })
      .expect(200);
    expect(partial.body.data).toMatchObject({
      gender: null,
      bloodGroup: 'O_POSITIVE',
      allergies: ['Penicillin', 'Peanuts'],
    });

    await ctx
      .http()
      .put('/api/v1/customer/emergency-profile')
      .set(bearer(token))
      .send({ bloodGroup: 'Z+' })
      .expect(400);
    await ctx
      .http()
      .put('/api/v1/customer/emergency-profile')
      .set(bearer(token))
      .send({ dateOfBirth: '2999-01-01' })
      .expect(400);
  });

  it('refuses to enable until contacts and privacy review are done', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/customer/emergency-profile/enable')
      .set(bearer(token))
      .expect(409);
    expect(res.body.error).toMatchObject({
      code: 'PROFILE_INCOMPLETE',
      details: { missing: ['EMERGENCY_CONTACT', 'PRIVACY_REVIEW'] },
    });
  });

  it('manages contacts: normalise, max 5, reorder, delete', async () => {
    const a = await ctx
      .http()
      .post('/api/v1/customer/emergency-contacts')
      .set(bearer(token))
      .send({ name: 'Rajesh Sharma', relationship: 'Father', phone: '98123 45678' })
      .expect(201);
    expect(a.body.data).toMatchObject({ phone: '+919812345678', priority: 1 });
    const b = await ctx
      .http()
      .post('/api/v1/customer/emergency-contacts')
      .set(bearer(token))
      .send({
        name: 'Priya Sharma',
        relationship: 'Sister',
        phone: '+91 98765 00000',
        alternatePhone: '9876500001',
      })
      .expect(201);
    expect(b.body.data.priority).toBe(2);
    await ctx
      .http()
      .post('/api/v1/customer/emergency-contacts')
      .set(bearer(token))
      .send({ name: 'X', relationship: 'Y', phone: '12' })
      .expect(400);

    const reordered = await ctx
      .http()
      .put('/api/v1/customer/emergency-contacts/order')
      .set(bearer(token))
      .send({ ids: [b.body.data.id, a.body.data.id] })
      .expect(200);
    expect(reordered.body.data.map((c: { name: string }) => c.name)).toEqual([
      'Priya Sharma',
      'Rajesh Sharma',
    ]);

    for (let i = 0; i < 3; i++)
      await ctx
        .http()
        .post('/api/v1/customer/emergency-contacts')
        .set(bearer(token))
        .send({ name: `Friend ${i}`, relationship: 'Friend', phone: `+9198765000${10 + i}` })
        .expect(201);
    const sixth = await ctx
      .http()
      .post('/api/v1/customer/emergency-contacts')
      .set(bearer(token))
      .send({ name: 'Too many', relationship: 'Friend', phone: '+919876500099' })
      .expect(409);
    expect(sixth.body.error.code).toBe('CONTACT_LIMIT_REACHED');

    const list = await ctx
      .http()
      .get('/api/v1/customer/emergency-contacts')
      .set(bearer(token))
      .expect(200);
    for (const c of list.body.data.slice(2))
      await ctx
        .http()
        .delete(`/api/v1/customer/emergency-contacts/${c.id}`)
        .set(bearer(token))
        .expect(200);
    const remaining = await ctx
      .http()
      .get('/api/v1/customer/emergency-contacts')
      .set(bearer(token))
      .expect(200);
    expect(remaining.body.data.map((c: { priority: number }) => c.priority)).toEqual([1, 2]);
  });

  it('saves visibility (privacy review) and the public page still shows nothing until enabled', async () => {
    await ctx
      .http()
      .put('/api/v1/customer/emergency-visibility')
      .set(bearer(token))
      .send({
        ...ALL_HIDDEN,
        showName: true,
        showBloodGroup: true,
        showAllergies: true,
        showEmergencyContacts: true,
      })
      .expect(200);
    const res = await pub();
    expect(res.body.data.state).toBe('ACTIVATED_PROFILE_INCOMPLETE');
    expect(res.body.data.profile).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/Rahul|Penicillin|9812345678/);
  });

  it('enabling makes the helmet ACTIVE and publishes only the selected fields', async () => {
    const enabled = await ctx
      .http()
      .post('/api/v1/customer/emergency-profile/enable')
      .set(bearer(token))
      .expect(200);
    expect(enabled.body.data).toMatchObject({ status: 'ACTIVE', completionPercent: 100 });
    expect((await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: helmet.id } })).status).toBe(
      'ACTIVE',
    );

    const res = await pub();
    expect(res.body.data).toEqual({
      state: 'ACTIVE',
      helmet: { modelName: 'Roadster X1', brand: 'Ozzo', helmetCode: helmet.helmetCode },
      message:
        'Emergency information and contacts were provided by the helmet owner and are not verified.',
      profile: {
        name: 'Rahul Sharma',
        bloodGroup: 'O_POSITIVE',
        bloodGroupLabel: 'O+',
        allergies: ['Penicillin', 'Peanuts'],
      },
      contacts: [
        {
          name: 'Priya Sharma',
          relationship: 'Sister',
          phone: '+919876500000',
          alternatePhone: '+919876500001',
        },
        { name: 'Rajesh Sharma', relationship: 'Father', phone: '+919812345678' },
      ],
    });
    const raw = JSON.stringify(res.body);
    for (const hidden of [
      'Asthma',
      'Salbutamol',
      'Inhaler',
      '1990',
      'organDonor',
      'medications',
      'emergencyNotes',
      helmet.id,
      userId,
      '+919876511111',
    ])
      expect(raw).not.toContain(hidden);
  });

  it('reflects visibility changes immediately (cache invalidated)', async () => {
    await pub(); // warm cache
    await ctx
      .http()
      .put('/api/v1/customer/emergency-visibility')
      .set(bearer(token))
      .send({ ...ALL_HIDDEN, showName: true, showEmergencyContacts: true })
      .expect(200);
    const res = await pub();
    expect(res.body.data.profile).toEqual({ name: 'Rahul Sharma' });
    expect(JSON.stringify(res.body)).not.toMatch(/Penicillin|O_POSITIVE/);
  });

  it('blocks edits that would break an enabled profile', async () => {
    const list = await ctx
      .http()
      .get('/api/v1/customer/emergency-contacts')
      .set(bearer(token))
      .expect(200);
    await ctx
      .http()
      .delete(`/api/v1/customer/emergency-contacts/${list.body.data[0].id}`)
      .set(bearer(token))
      .expect(200);
    const last = await ctx
      .http()
      .delete(`/api/v1/customer/emergency-contacts/${list.body.data[1].id}`)
      .set(bearer(token))
      .expect(409);
    expect(last.body.error.code).toBe('PROFILE_REQUIREMENT');
    const noName = await ctx
      .http()
      .put('/api/v1/customer/emergency-profile')
      .set(bearer(token))
      .send({ name: null })
      .expect(409);
    expect(noName.body.error.code).toBe('PROFILE_REQUIREMENT');
  });

  it('serves the photo publicly only while visible; strips metadata', async () => {
    const img = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#808080' },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Artist: 'owner-secret' } } })
      .toBuffer();
    await ctx
      .http()
      .put('/api/v1/customer/emergency-profile/photo')
      .set(bearer(token))
      .attach('photo', Buffer.from('<svg/>'), { filename: 'x.jpg', contentType: 'image/jpeg' })
      .expect(400);
    await ctx
      .http()
      .put('/api/v1/customer/emergency-profile/photo')
      .set(bearer(token))
      .attach('photo', img, { filename: 'me.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const own = await ctx
      .http()
      .get('/api/v1/customer/emergency-profile/photo')
      .set(bearer(token))
      .buffer(true)
      .expect(200);
    expect(own.headers['content-type']).toBe('image/webp');
    expect((own.body as Buffer).includes(Buffer.from('owner-secret'))).toBe(false);

    await ctx.http().get(`/api/v1/public/emergency/${helmet.publicToken}/photo`).expect(404);
    await ctx
      .http()
      .put('/api/v1/customer/emergency-visibility')
      .set(bearer(token))
      .send({ ...ALL_HIDDEN, showName: true, showPhoto: true })
      .expect(200);
    const res = await pub();
    expect(res.body.data.profile.photoUrl).toBe(
      `/api/v1/public/emergency/${helmet.publicToken}/photo`,
    );
    const photo = await ctx.http().get(res.body.data.profile.photoUrl).buffer(true).expect(200);
    expect(photo.headers['content-type']).toBe('image/webp');
  });

  it('admins see only operational owner info (masked mobile + profile status)', async () => {
    const admin = await createAdmin(ctx, 'SUPPORT');
    const session = await login(ctx, admin.email, admin.password);
    const detail = await ctx
      .http()
      .get(`/api/v1/admin/helmets/${helmet.id}`)
      .set(bearer(session.token))
      .expect(200);
    expect(detail.body.data.owner).toEqual({
      customerId: expect.any(String),
      maskedMobile: '+91******1111',
      since: expect.any(String),
      emergencyProfileStatus: 'ACTIVE',
    });
    expect(JSON.stringify(detail.body)).not.toMatch(/Rahul|Penicillin|9876511111/);
  });

  it('disabling hides everything immediately and returns the helmet to ACTIVATED', async () => {
    await ctx
      .http()
      .post('/api/v1/customer/emergency-profile/disable')
      .set(bearer(token))
      .expect(200);
    expect((await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: helmet.id } })).status).toBe(
      'ACTIVATED',
    );
    const res = await pub();
    expect(res.body.data.state).toBe('ACTIVATED_PROFILE_INCOMPLETE');
    expect(res.body.data).not.toHaveProperty('profile');
    expect(res.body.data).not.toHaveProperty('contacts');
    expect(JSON.stringify(res.body)).not.toMatch(/Rahul|Sharma|\+9198/);
    await ctx.http().get(`/api/v1/public/emergency/${helmet.publicToken}/photo`).expect(404);
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          action: { in: ['emergency_profile.enabled', 'emergency_profile.disabled'] },
          userId,
        },
      }),
    ).toBe(2);
  });

  it('deduplicates repeated scans from the same device', async () => {
    await ctx.prisma.helmetScan.deleteMany({ where: { helmetId: helmet.id } });
    await ctx.redis.flushdb();
    for (let i = 0; i < 4; i++)
      await ctx
        .http()
        .get(`/api/v1/public/emergency/${helmet.publicToken}`)
        .set('User-Agent', 'Dedup/1.0')
        .expect(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await ctx.prisma.helmetScan.count({ where: { helmetId: helmet.id, userAgent: 'Dedup/1.0' } }),
    ).toBe(1);
  });
});
