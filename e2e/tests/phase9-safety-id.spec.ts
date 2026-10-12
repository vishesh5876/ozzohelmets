import {
  type APIRequestContext,
  type Browser,
  devices,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from '@playwright/test';

/**
 * Phase 9: the Safety ID is the emergency QR identity. A standalone Safety ID (sticker / card) is
 * generated, printed, activated and shared without any helmet; a helmet-linked Safety ID joins
 * the same account and becomes the customer's helmet in the same step; each Safety ID shares
 * independently; a standalone Safety ID moves to a new owner with a Transfer Code; admins find,
 * deactivate and reactivate Safety IDs. The emergency page is about the person, never the product.
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';
const PORTAL = process.env.E2E_PORTAL_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';

const run = Date.now().toString(36);
const PASSWORD = 'phase nine rider';
const OWNER = 'Asha Safety';
const EMAIL = `p9.${run}@example.com`;
const NEW_EMAIL = `p9.new.${run}@example.com`;

interface Sid {
  safetyCode: string;
  qrUrl: string;
  token: string;
  pin: string;
}

async function adminAuth(api: APIRequestContext) {
  const login = await api.post(`${API}/admin/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  return { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
}

/** One helmet batch with "Generate a Safety ID for each helmet" (the default). */
async function manufactureLinked(api: APIRequestContext) {
  const auth = await adminAuth(api);
  const model = await api.post(`${API}/admin/helmet-models`, {
    headers: auth,
    data: { name: `P9 Model ${run}`, sku: `P9-${run.toUpperCase()}`, brand: 'Ozzo' },
  });
  const batch = await api.post(`${API}/admin/batches`, {
    headers: auth,
    data: {
      helmetModelId: (await model.json()).data.id,
      quantity: 1,
      manufacturingDate: new Date().toISOString().slice(0, 10),
      notes: 'Phase 9 acceptance test batch',
    },
  });
  const batchId = (await batch.json()).data.id as string;
  await api.post(`${API}/admin/batches/${batchId}/generate`, { headers: auth });
  await expect
    .poll(
      async () =>
        (await (await api.get(`${API}/admin/batches/${batchId}`, { headers: auth })).json()).data
          .generationStatus,
      { timeout: 60_000 },
    )
    .toBe('COMPLETED');
  const csv = await (
    await api.get(`${API}/admin/batches/${batchId}/export/manufacturing.csv`, { headers: auth })
  ).text();
  await api.post(`${API}/admin/batches/${batchId}/mark-printed`, { headers: auth });
  const [helmetCode, , , , qrUrl, pin, safetyCode] = csv.trim().split('\r\n')[1]!.split(',');
  return {
    helmetCode: helmetCode!,
    safetyCode: safetyCode!,
    qrUrl: qrUrl!,
    token: qrUrl!.split('/e/')[1]!,
    pin: pin!,
  };
}

const phone = async (browser: Browser) =>
  (await browser.newContext({ ...devices['Pixel 7'] })).newPage();

async function adminPage(browser: Browser) {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await page.goto(`${ADMIN_URL}/login`);
  await page.fill('#email', ADMIN_EMAIL);
  await page.fill('#password', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('system-status')).toBeVisible();
  return page;
}

/** The public emergency page text (a fresh, signed-out phone). */
async function publicText(browser: Browser, url: string) {
  const page = await phone(browser);
  await page.goto(url);
  await expect(page.locator('main')).not.toHaveText('');
  await page.waitForLoadState('networkidle');
  const text = await page.locator('body').innerText();
  return { page, text };
}

test.describe.serial('Phase 9: Safety ID architecture + standalone emergency QR', () => {
  let admin: Page;
  let owner: Page;
  let batchUrl: string;
  let standalone: Sid;
  let linked: Awaited<ReturnType<typeof manufactureLinked>>;
  let standaloneId: string;

  test('1: admin creates a standalone Safety ID batch and it generates', async ({ browser }) => {
    admin = await adminPage(browser);
    await admin.getByRole('link', { name: 'Safety ID Batches' }).click();
    await admin.getByRole('button', { name: 'New Safety ID batch' }).click();
    await admin.selectOption('#sib-mode', 'STANDALONE');
    await admin.fill('#sib-qty', '2');
    await admin.fill('#sib-notes', `Phase 9 acceptance ${run}`);
    await admin.getByRole('button', { name: 'Create and generate' }).click();
    await admin.waitForURL(/\/safety-id-batches\/[0-9a-f-]{36}$/);
    await expect(admin.getByText('/ 2 Safety IDs')).toBeVisible();
    // "Mark printed" appears only once generation has completed.
    await expect(admin.getByRole('button', { name: 'Mark printed' })).toBeVisible({
      timeout: 60_000,
    });
    batchUrl = admin.url();
  });

  test('2: the Safety ID CSV carries one-time PINs; the print sheet has the PIN instruction', async () => {
    const api = await playwrightRequest.newContext();
    const auth = await adminAuth(api);
    const batchId = batchUrl.split('/').pop()!;
    const res = await api.get(`${API}/admin/safety-id-batches/${batchId}/export/safety-ids.csv`, {
      headers: auth,
    });
    expect(res.ok()).toBeTruthy();
    expect(res.headers()['x-pins-included']).toBe('2');
    expect(res.headers()['cache-control']).toContain('no-store');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]!.startsWith('safetyCode,')).toBe(true);
    const rows = lines.slice(1).map((l) => l.split(','));
    expect(rows).toHaveLength(2);
    const [safetyCode, qrUrl, pin, helmetCode] = rows[0]!;
    expect(safetyCode).toMatch(/^SI-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(pin).toMatch(/^[23456789A-HJ-NP-Z]{8}$/);
    expect(helmetCode).toBe('');
    standalone = {
      safetyCode: safetyCode!,
      qrUrl: qrUrl!,
      token: qrUrl!.split('/e/')[1]!,
      pin: pin!,
    };

    const sheet = await api.get(
      `${API}/admin/safety-id-batches/${batchId}/export/print-sheet.html`,
      { headers: auth },
    );
    expect(sheet.ok()).toBeTruthy();
    expect(sheet.headers()['cache-control']).toContain('no-store');
    const html = await sheet.text();
    expect(html).toContain('Use this PIN once to activate your Safety ID.');
    expect(html).toContain(standalone.safetyCode);
    await api.dispose();
  });

  test('3: marking the batch printed destroys the PIN escrow', async () => {
    await admin.goto(batchUrl);
    await admin.getByRole('button', { name: 'Mark printed' }).click();
    await admin.getByRole('button', { name: 'Confirm printed' }).click();
    await expect(admin.getByText('PINs in escrow').locator('..')).toContainText('0');
    const api = await playwrightRequest.newContext();
    const res = await api.get(
      `${API}/admin/safety-id-batches/${batchUrl.split('/').pop()}/export/safety-ids.csv`,
      { headers: await adminAuth(api) },
    );
    // After printing the export carries no PINs at all.
    expect(res.headers()['x-pins-included']).toBe('0');
    await api.dispose();
  });

  test('4: admin sees the PIN state of a printed, unactivated Safety ID', async () => {
    await admin.goto(`${ADMIN_URL}/safety-ids`);
    await admin.getByLabel('Search Safety IDs').fill(standalone.safetyCode);
    await admin
      .getByTestId('safety-id-row')
      .getByRole('link', { name: standalone.safetyCode })
      .click();
    await expect(admin.getByTestId('pin-state')).toHaveText('Escrow purged');
    await expect(admin.getByTestId('safety-linked-helmet')).toContainText(/standalone|not linked/i);
  });

  test('5: an anonymous scan shows the Safety ID is not activated, with no product data', async ({
    browser,
  }) => {
    const { page, text } = await publicText(browser, standalone.qrUrl);
    await expect(page.getByRole('heading', { name: 'Safety ID not activated' })).toBeVisible();
    expect(text).toContain('This Safety ID has not been activated yet.');
    expect(text).not.toMatch(/HM-[0-9A-Z]{4}/);
    await page.context().close();
  });

  test('6: the verify page says the standalone Safety ID is registered, no product linked', async ({
    browser,
  }) => {
    const page = await phone(browser);
    await page.goto(`${PORTAL}/verify/${standalone.token}`);
    await expect(page.getByText('✓ Safety ID verified')).toBeVisible();
    await expect(page.getByText('This Safety ID is registered with Ozzo.')).toBeVisible();
    await expect(
      page.getByText('No registered product is currently linked to this Safety ID.'),
    ).toBeVisible();
    await page.context().close();
  });

  test('7: activation starts from the Safety ID: PIN, then a new account', async ({ browser }) => {
    owner = await phone(browser);
    await owner.goto(standalone.qrUrl);
    await owner.getByRole('link', { name: 'Activate Safety ID' }).click();
    await expect(owner.getByRole('heading', { name: 'Activate your Safety ID' })).toBeVisible();
    await expect(
      owner.getByText('Enter the Activation PIN printed with your Safety ID.', { exact: false }),
    ).toBeVisible();
    await owner.fill('#pin', standalone.pin);
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(owner.getByText(/PIN accepted/)).toBeVisible();
    await owner.fill('#reg-email', EMAIL);
    await owner.fill('#reg-name', OWNER);
    await owner.fill('#reg-new', PASSWORD);
    await owner.fill('#reg-confirm', PASSWORD);
    await owner.getByRole('button', { name: 'Activate Safety ID' }).click();
    await owner.getByTestId('recovery-saved').check();
    await owner.getByRole('button', { name: 'Continue' }).click();
  });

  test('8: the success screen names the Safety ID and says sharing is not enabled yet', async () => {
    await expect(
      owner.getByRole('heading', { name: 'Your Safety ID is activated.' }),
    ).toBeVisible();
    const done = owner.getByTestId('activation-done');
    await expect(done).toContainText(standalone.safetyCode);
    await expect(done).toContainText('Emergency SharingNot enabled yet');
    await expect(done).not.toContainText('Linked helmet');
  });

  test('9: emergency setup turns sharing on for this Safety ID', async () => {
    await owner.getByRole('button', { name: 'Complete emergency setup' }).click();
    await expect(owner.getByTestId('setup-progress')).toContainText('Emergency details');
    await owner.fill('#p-name', OWNER);
    await owner.selectOption('#p-blood', 'O_POSITIVE');
    await owner.fill('#p-allergies', 'Penicillin');
    await owner.getByRole('button', { name: 'Save and continue' }).click();
    await owner.getByRole('button', { name: 'Add emergency contact' }).click();
    await owner.fill('#c-name-new', 'Vikram Safety');
    await owner.fill('#c-rel-new', 'Brother');
    await owner.fill('#c-phone-new', '98123 40009');
    await owner.getByRole('button', { name: 'Add contact' }).click();
    await owner.getByRole('button', { name: 'Continue' }).click();
    for (const key of ['showName', 'showBloodGroup', 'showAllergies', 'showEmergencyContacts']) {
      const toggle = owner.getByTestId(`vis-${key}`);
      if (!(await toggle.isChecked())) await owner.locator('label').filter({ has: toggle }).click();
    }
    await owner.getByRole('button', { name: 'Save and continue' }).click();
    await owner.getByRole('button', { name: 'Looks good' }).click();
    await owner.getByRole('button', { name: 'Turn on emergency profile' }).click();
    const done = owner.getByTestId('setup-complete');
    await expect(done).toContainText(standalone.safetyCode);
    await expect(done).toContainText('Emergency SharingOn');
  });

  test('10: the emergency page is about the person; the Safety ID sits at the bottom', async ({
    browser,
  }) => {
    const { page, text } = await publicText(browser, standalone.qrUrl);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Emergency information' }),
    ).toBeVisible();
    expect(text).toContain(OWNER);
    expect(text).toContain('Penicillin');
    await expect(page.getByRole('link', { name: /^Call Vikram/ })).toHaveAttribute(
      'href',
      'tel:+919812340009',
    );
    const main = await page.locator('main').innerText();
    expect(main.indexOf(standalone.safetyCode)).toBeGreaterThan(main.indexOf('Vikram Safety'));
    // Standalone: no product at all, so no product link.
    await expect(page.getByRole('link', { name: 'View product information' })).toHaveCount(0);
    for (const leak of [EMAIL, standalone.pin, 'Helmet ID', 'Warranty'])
      expect(text).not.toContain(leak);
    await page.context().close();
  });

  test('11: a helmet batch generates a Safety ID for each helmet', async () => {
    const api = await playwrightRequest.newContext();
    linked = await manufactureLinked(api);
    expect(linked.safetyCode).toMatch(/^SI-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(linked.qrUrl).toContain('/e/');
    await api.dispose();
  });

  test('12: the signed-in customer adds the helmet Safety ID; the helmet becomes theirs', async () => {
    await owner.goto(linked.qrUrl);
    await owner.getByRole('link', { name: 'Activate Safety ID' }).click();
    await owner.fill('#pin', linked.pin);
    await owner.getByRole('button', { name: 'Add Safety ID to my account' }).click();
    const done = owner.getByTestId('activation-done');
    await expect(done).toContainText(linked.safetyCode);
    await expect(done).toContainText('Linked helmet');
    await expect(done).toContainText(linked.helmetCode);
    await expect(done).toContainText('Emergency SharingNot enabled yet');
  });

  test('13: the dashboard counts Safety IDs: 1 active / 1 needs setup', async () => {
    await owner.goto(`${PORTAL}/app`);
    await expect(owner.getByTestId('safety-id-summary')).toContainText(
      '1 Safety ID active / 1 needs setup',
    );
  });

  test('14: My Safety IDs lists the standalone and the helmet-linked Safety ID', async () => {
    await owner.getByRole('link', { name: 'My Safety IDs' }).first().click();
    await expect(owner.getByRole('heading', { name: 'My Safety IDs' })).toBeVisible();
    const cards = owner.getByTestId('safety-id-card');
    await expect(cards).toHaveCount(2);
    const s = cards.filter({ hasText: standalone.safetyCode });
    await expect(s).toContainText('Standalone (not linked to a helmet)');
    await expect(s).toContainText('Emergency Sharing: On');
    const l = cards.filter({ hasText: linked.safetyCode });
    await expect(l).toContainText(linked.helmetCode);
    await expect(l).toContainText('Emergency Sharing: Not enabled yet');
    standaloneId = (await s.getAttribute('href'))!.split('/').pop()!;
  });

  test('15: sharing is switched on for the second Safety ID on its own page', async () => {
    await owner.getByTestId('safety-id-card').filter({ hasText: linked.safetyCode }).click();
    await owner.getByRole('button', { name: 'Turn on emergency sharing' }).click();
    await expect(owner.getByTestId('safety-sharing')).toContainText('Emergency Sharing: On');
    await owner.goto(`${PORTAL}/app`);
    await expect(owner.getByTestId('safety-id-summary')).toContainText('2 Safety IDs active');
  });

  test('16: a linked Safety ID offers "View product information"', async ({ browser }) => {
    const { page, text } = await publicText(browser, linked.qrUrl);
    expect(text).toContain(OWNER);
    expect(text).not.toContain(linked.helmetCode);
    await page.getByRole('link', { name: 'View product information' }).click();
    await expect(page.getByText('✓ Product identity verified')).toBeVisible();
    await page.context().close();
  });

  test('17: the helmet page links to its Safety ID', async () => {
    await owner.goto(`${PORTAL}/app/helmets`);
    await owner
      .getByTestId('helmet-card')
      .filter({ hasText: linked.helmetCode })
      .getByRole('link', { name: 'View helmet' })
      .click();
    await owner.getByRole('link', { name: 'View Safety ID' }).click();
    await expect(owner.getByRole('heading', { level: 1, name: linked.safetyCode })).toBeVisible();
  });

  test('18–19: sharing is independent per Safety ID', async ({ browser }) => {
    await owner.goto(`${PORTAL}/app/safety-ids/${standaloneId}`);
    await owner.getByRole('button', { name: 'Turn off emergency sharing' }).click();
    await expect(owner.getByTestId('safety-sharing')).toContainText(
      'Emergency Sharing: Not enabled yet',
    );
    let view = await publicText(browser, standalone.qrUrl);
    expect(view.text).not.toContain(OWNER);
    expect(view.text).not.toContain('Penicillin');
    await view.page.context().close();
    view = await publicText(browser, linked.qrUrl);
    expect(view.text).toContain(OWNER);
    await view.page.context().close();

    await owner.getByRole('button', { name: 'Turn on emergency sharing' }).click();
    await expect(owner.getByTestId('safety-sharing')).toContainText('Emergency Sharing: On');
  });

  test('20: the owner issues a one-time Transfer Code for the standalone Safety ID', async () => {
    const card = owner.getByTestId('safety-transfer');
    await card.locator('#confirm-password').fill(PASSWORD);
    await card.getByRole('button', { name: 'Confirm password' }).click();
    await card.getByRole('button', { name: 'Generate Transfer Code' }).click();
    await expect(card.getByTestId('safety-transfer-code')).toHaveText(/\S{6,}/);
  });

  test('21: a new person claims it with the Safety ID and Transfer Code', async ({ browser }) => {
    const code = (await owner.getByTestId('safety-transfer-code').innerText()).trim();
    const next = await phone(browser);
    await next.goto(`${PORTAL}/claim?type=safety-id`);
    await expect(next.getByRole('heading', { name: 'Claim a Safety ID' })).toBeVisible();
    await next.fill('#claim-safety', standalone.safetyCode);
    await next.fill('#claim-safety-code', code);
    await next.getByRole('button', { name: 'Continue' }).click();
    await next.fill('#claim-email', NEW_EMAIL);
    await next.fill('#claim-new', PASSWORD);
    await next.fill('#claim-confirm', PASSWORD);
    await next.getByRole('button', { name: 'Create account and claim' }).click();
    await next.getByTestId('recovery-saved').check();
    await next.getByRole('button', { name: 'Continue' }).click();
    await expect(
      next.getByRole('heading', { level: 1, name: standalone.safetyCode }),
    ).toBeVisible();
    await expect(next.getByTestId('safety-sharing')).toContainText(
      'Emergency Sharing: Not enabled yet',
    );
    await next.context().close();
  });

  test('22: the previous owner’s information no longer shows on that Safety ID', async ({
    browser,
  }) => {
    const { text, page } = await publicText(browser, standalone.qrUrl);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain('Penicillin');
    expect(text).not.toContain('Vikram');
    await page.context().close();
  });

  test('23: the previous owner keeps only the helmet-linked Safety ID', async () => {
    await owner.goto(`${PORTAL}/app/safety-ids`);
    await expect(owner.getByTestId('safety-id-card')).toHaveCount(1);
    await expect(owner.getByTestId('safety-id-card')).toContainText(linked.safetyCode);
  });

  test('24: admin finds the Safety ID: new owner, PIN consumed, ownership history', async () => {
    await admin.goto(`${ADMIN_URL}/safety-ids`);
    await admin.getByLabel('Search Safety IDs').fill(standalone.safetyCode);
    await admin
      .getByTestId('safety-id-row')
      .getByRole('link', { name: standalone.safetyCode })
      .click();
    await expect(admin.getByTestId('pin-state')).toHaveText('Consumed');
    await expect(admin.getByText('Ownership history')).toBeVisible();
  });

  test('25: admin deactivates (password confirmed) and reactivates the Safety ID', async ({
    browser,
  }) => {
    await admin.getByRole('button', { name: 'Deactivate' }).click();
    await admin.fill('#action-reason', 'Phase 9 acceptance: sticker reported damaged');
    await admin.fill('#action-password', ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Confirm' }).click();
    await expect(admin.getByTestId('safety-status')).toHaveText('Deactivated');
    const view = await publicText(browser, standalone.qrUrl);
    expect(view.text).toContain('This Safety ID is no longer active.');
    await view.page.context().close();

    await admin.getByRole('button', { name: 'Reactivate' }).click();
    await admin.fill('#action-reason', 'Phase 9 acceptance: replacement confirmed');
    await admin.getByRole('button', { name: 'Confirm' }).click();
    await expect(admin.getByTestId('safety-status')).not.toHaveText('Deactivated');
  });

  test('26: the admin customer page lists Safety IDs separately from helmets', async () => {
    await admin.goto(`${ADMIN_URL}/customers?q=${encodeURIComponent(EMAIL)}`);
    await admin
      .getByTestId('customer-row')
      .filter({ hasText: EMAIL })
      .getByRole('link')
      .first()
      .click();
    const section = admin.getByTestId('customer-safety-ids');
    await expect(section).toContainText(linked.safetyCode);
    await expect(section).not.toContainText(standalone.safetyCode);
    await admin.context().close();
    await owner.context().close();
  });
});
