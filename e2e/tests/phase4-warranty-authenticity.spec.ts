import {
  type APIRequestContext,
  type Browser,
  devices,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';
const PORTAL = process.env.E2E_PORTAL_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';

const run = Date.now().toString(36).toUpperCase();
const A_PASSWORD = 'warranty owner rides east';
const B_PASSWORD = 'second owner rides west';
const Z_PASSWORD = 'former owner rides home';
const A_NAME = 'Meera Iyer';
const INVOICE = `INV-${run}`;
const SELLER = 'Helmet House Pune';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const PURCHASE = daysAgo(20);
const CORRECTED = daysAgo(30);
/** A tiny, structurally valid PDF with no active content. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

interface Helmet {
  id: string;
  helmetCode: string;
  qrUrl: string;
  pin: string;
}

interface Account {
  token: string;
  customerId: string;
}

async function manufacture(api: APIRequestContext, count: number): Promise<Helmet[]> {
  const login = await api.post(`${API}/admin/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const auth = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
  const model = await api.post(`${API}/admin/helmet-models`, {
    headers: auth,
    data: { name: `P4 Roadster ${run}`, sku: `P4-${run}`, brand: 'Ozzo' },
  });
  const batch = await api.post(`${API}/admin/batches`, {
    headers: auth,
    data: {
      helmetModelId: (await model.json()).data.id,
      quantity: count,
      manufacturingDate: daysAgo(60),
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
  const helmets: Helmet[] = [];
  for (const line of csv.trim().split('\r\n').slice(1)) {
    const [helmetCode, , , , qrUrl, pin] = line.split(',');
    const found = await api.get(`${API}/admin/helmets`, {
      headers: auth,
      params: { search: helmetCode! },
    });
    const id = (await found.json()).data[0].id as string;
    for (const status of ['IN_INVENTORY', 'SOLD']) {
      const res = await api.patch(`${API}/admin/helmets/${id}/status`, {
        headers: auth,
        data: { status },
      });
      expect(res.ok()).toBeTruthy();
    }
    helmets.push({ id, helmetCode: helmetCode!, qrUrl: qrUrl!, pin: pin! });
  }
  return helmets;
}

async function mobile(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  return ctx.newPage();
}

async function scan(browser: Browser, url: string) {
  const page = await mobile(browser);
  await page.goto(url);
  await expect(page.locator('main')).not.toContainText('Loading emergency information');
  const text = await page.locator('body').innerText();
  return { page, text };
}

async function signIn(page: Page, helmetCode: string, password: string) {
  await page.goto(`${PORTAL}/login`);
  await page.fill('#login-helmet', helmetCode);
  await page.fill('#login-password', password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);
}

async function register(
  api: APIRequestContext,
  helmet: Helmet,
  password: string,
  name: string,
): Promise<Account> {
  const res = await api.post(`${API}/customer/activation/register`, {
    data: { helmetCode: helmet.helmetCode, pin: helmet.pin, password, name },
  });
  expect(res.ok()).toBeTruthy();
  const data = (await res.json()).data;
  return { token: data.accessToken as string, customerId: data.customer.customerId as string };
}

/** Moves `helmet` from `from` to `to` through the real transfer API. */
async function transfer(
  api: APIRequestContext,
  helmet: Helmet,
  from: Account,
  fromPassword: string,
  to: Account,
) {
  const auth = { Authorization: `Bearer ${from.token}` };
  const reauth = await api.post(`${API}/customer/auth/reauthenticate`, {
    headers: auth,
    data: { password: fromPassword },
  });
  const recent = (await reauth.json()).data.recentAuthToken as string;
  const start = await api.post(`${API}/customer/helmets/${helmet.id}/transfer`, {
    headers: { ...auth, 'X-Recent-Auth': recent },
  });
  expect(start.ok()).toBeTruthy();
  const claim = await api.post(`${API}/customer/transfers/claim`, {
    headers: { Authorization: `Bearer ${to.token}` },
    data: { helmetCode: helmet.helmetCode, transferCode: (await start.json()).data.transferCode },
  });
  expect(claim.ok()).toBeTruthy();
}

async function adminSignIn(page: Page) {
  await page.goto(`${ADMIN_URL}/login`);
  await page.fill('#email', ADMIN_EMAIL);
  await page.fill('#password', ADMIN_PASSWORD);
  await page.click('button[type=submit]');
  await expect(page.getByText('Helmets by status')).toBeVisible();
}

async function openVerify(browser: Browser, helmet: Helmet) {
  const page = await mobile(browser);
  await page.goto(helmet.qrUrl.replace('/e/', '/verify/'));
  await expect(page.locator('main')).not.toContainText('Checking…');
  return { page, text: await page.locator('body').innerText() };
}

test.describe.serial('Phase 4: Customer ID → warranty → verification → transfer → admin', () => {
  let helmet: Helmet; // the journey helmet (A → B)
  let a: Account;
  let b: Account;
  let z: Account; // ends up with zero helmets
  let customer: Page;
  let admin: Page;

  test.beforeAll(async () => {
    const api = await playwrightRequest.newContext();
    const made = await manufacture(api, 3);
    helmet = made[0]!;
    a = await register(api, helmet, A_PASSWORD, A_NAME);
    b = await register(api, made[1]!, B_PASSWORD, 'Bina Das');
    z = await register(api, made[2]!, Z_PASSWORD, 'Zubin Mehta');
    await transfer(api, made[2]!, z, Z_PASSWORD, b);
    // A shares emergency information on the journey helmet.
    const auth = { Authorization: `Bearer ${a.token}` };
    await api.put(`${API}/customer/emergency-profile`, {
      headers: auth,
      data: { name: A_NAME, bloodGroup: 'O_POSITIVE', allergies: ['Penicillin'] },
    });
    await api.post(`${API}/customer/emergency-contacts`, {
      headers: auth,
      data: { name: 'Ravi Iyer', relationship: 'Brother', phone: '+919812300002' },
    });
    await api.put(`${API}/customer/emergency-visibility`, {
      headers: auth,
      data: {
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
      },
    });
    const enable = await api.post(`${API}/customer/helmets/${helmet.id}/emergency/enable`, {
      headers: auth,
    });
    expect(enable.ok()).toBeTruthy();
    await api.dispose();
  });

  test('1–3: A signs in with the Customer ID, sees it on the account page, opens the helmet', async ({
    browser,
  }) => {
    customer = await (await browser.newContext()).newPage();
    await signIn(customer, a.customerId.toLowerCase(), A_PASSWORD);
    await customer.goto(`${PORTAL}/app/account`);
    await expect(customer.getByTestId('customer-id')).toContainText(a.customerId);
    await expect(
      customer.getByText('Use your Customer ID to sign in even if you no longer own a helmet.'),
    ).toBeVisible();
    await customer.goto(`${PORTAL}/app/helmets`);
    const card = customer.getByTestId('helmet-card').filter({ hasText: helmet.helmetCode });
    await card.getByRole('link', { name: 'View' }).click();
    await expect(customer.getByRole('heading', { name: helmet.helmetCode })).toBeVisible();
    await expect(customer.getByTestId('warranty-section')).toContainText('Warranty not registered');
  });

  test('4–7: A registers the warranty, uploads proof, and sees it active', async () => {
    await customer.getByRole('link', { name: 'Register warranty' }).click();
    await expect(customer.getByRole('heading', { name: 'Warranty' })).toBeVisible();
    await customer.fill('#w-date', PURCHASE);
    await customer.selectOption('#w-channel', 'RETAIL_STORE');
    await customer.fill('#w-seller', SELLER);
    await customer.fill('#w-invoice', INVOICE);
    await customer.getByRole('button', { name: 'Review' }).click();
    await customer.getByRole('button', { name: 'Register warranty' }).click();
    const card = customer.getByTestId('warranty-card');
    await expect(card).toContainText('Warranty active');
    await expect(card).toContainText(INVOICE);
    await expect(card).toContainText('Not uploaded');
    await customer.getByTestId('proof-input').setInputFiles({
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await expect(card).toContainText('Uploaded');
    await expect(card.getByRole('button', { name: 'Replace document' })).toBeVisible();
    await customer.goto(`${PORTAL}/app/helmets/${helmet.id}`);
    await expect(customer.getByTestId('warranty-section')).toContainText('Warranty active until');
  });

  test('8–10: signed out, the public verify page shows identity verified and nothing private; the emergency page is independent', async ({
    browser,
  }) => {
    await customer.goto(`${PORTAL}/app/account`);
    await customer.getByRole('button', { name: 'Sign out', exact: true }).last().click();
    await expect(customer).not.toHaveURL(/\/app(\/|$)/);

    const { page, text } = await openVerify(browser, helmet);
    expect(text).toContain('Product identity verified');
    expect(text).toContain(helmet.helmetCode);
    expect(text).toContain(`P4-${run}`);
    expect(text).toMatch(/Warranty\s*Active until/);
    expect(text).toMatch(/registered identity, not the physical helmet/);
    for (const leak of [A_NAME, 'Penicillin', INVOICE, SELLER, a.customerId, helmet.pin])
      expect(text).not.toContain(leak);
    expect(text.toLowerCase()).not.toContain('counterfeit');
    // The emergency page is reachable from here and still serves the approved profile.
    await page.getByRole('link', { name: 'Emergency information' }).click();
    await expect(page.locator('main')).toContainText(A_NAME);
    await page.context().close();
  });

  test('11–13: after a transfer, B sees the warranty status but not A’s private details or document', async ({
    browser,
  }) => {
    const api = await playwrightRequest.newContext();
    await transfer(api, helmet, a, A_PASSWORD, b);
    await api.dispose();
    await signIn(customer, b.customerId, B_PASSWORD);
    await customer.goto(`${PORTAL}/app/helmets/${helmet.id}/warranty`);
    const card = customer.getByTestId('warranty-card');
    await expect(card).toContainText('Warranty active');
    await expect(card).toContainText(
      'Purchase details and documents from a previous owner are private and not shown.',
    );
    await expect(card).not.toContainText(INVOICE);
    await expect(card).not.toContainText(SELLER);
    await expect(card.getByRole('button', { name: 'Download' })).toHaveCount(0);
    // The document endpoint refuses the new owner too.
    const res = await customer.request.get(`${API}/customer/helmets/${helmet.id}/warranty/proof`);
    expect(res.ok()).toBeFalsy();
    const { text, page } = await openVerify(browser, helmet);
    expect(text).toMatch(/Warranty\s*Active until/);
    await page.context().close();
  });

  test('14–17: admin finds the warranty, corrects it with a reason, history records it', async ({
    browser,
  }) => {
    admin = await (await browser.newContext()).newPage();
    await adminSignIn(admin);
    await admin.getByRole('link', { name: 'Warranties' }).click();
    await admin.getByLabel('Search warranties').fill(helmet.helmetCode);
    await admin.getByRole('link', { name: helmet.helmetCode }).click();
    await expect(admin.getByRole('heading', { name: helmet.helmetCode })).toBeVisible();
    await expect(admin.locator('main')).toContainText(INVOICE);
    await expect(admin.locator('main')).toContainText('Proof of purchase: uploaded');

    await admin.fill('#wc-purchase', CORRECTED);
    await admin.selectOption('#wc-reason', 'DOCUMENT_VERIFIED');
    await admin.fill('#wc-note', 'Invoice shows an earlier date');
    await admin.getByRole('button', { name: 'Save correction' }).click();
    const history = admin.getByTestId('warranty-history');
    await expect(history).toContainText('Invoice shows an earlier date');
    await expect(history).toContainText('Document verified');
    await expect(history).toContainText(CORRECTED);
  });

  test('18–19: admin voids the warranty (password confirmed); public verify reflects it; restore returns it', async ({
    browser,
  }) => {
    await admin.selectOption('#wv-reason', 'INVALID_PURCHASE');
    await admin.fill('#wv-password', ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Void warranty' }).click();
    await expect(admin.getByRole('heading', { name: 'Restore warranty' })).toBeVisible();
    let view = await openVerify(browser, helmet);
    expect(view.text).toMatch(/Warranty\s*Not active/);
    expect(view.text).toContain('Product identity verified');
    await view.page.context().close();

    await admin.fill('#wr-note', 'Voided in error');
    await admin.getByRole('button', { name: 'Restore warranty' }).click();
    await expect(admin.getByRole('heading', { name: 'Void warranty' })).toBeVisible();
    await expect(admin.getByTestId('warranty-history')).toContainText('Voided in error');
    view = await openVerify(browser, helmet);
    expect(view.text).toMatch(/Warranty\s*Active until/);
    await view.page.context().close();
  });

  test('20–22: an invalid token is “could not verify” (never counterfeit); a public report reaches admin review', async ({
    browser,
  }) => {
    const page = await mobile(browser);
    await page.goto(`${PORTAL}/verify/ZZZZZZZZZZZZZZZZZZZZZZ`);
    await expect(
      page.getByRole('heading', { name: 'We could not verify this Helmet ID' }),
    ).toBeVisible();
    await expect(page.getByText('Check the QR code or contact support.')).toBeVisible();
    expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('counterfeit');

    await page.goto(helmet.qrUrl.replace('/e/', '/verify/'));
    await page.getByRole('button', { name: 'Report a problem with this product' }).click();
    await page.selectOption('#report-reason', 'QR_COPIED');
    await page.fill('#report-description', `Same sticker seen on another helmet ${run}`);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(
      page.getByText('Your report has been received and will be reviewed.'),
    ).toBeVisible();
    await page.context().close();

    await admin.getByRole('link', { name: 'Product reports' }).click();
    const row = admin.getByTestId('product-report').filter({ hasText: run });
    await expect(row).toContainText(helmet.helmetCode);
    await expect(row).toContainText('Qr copied');
    await row.getByLabel('Report status').selectOption('REVIEWING');
    // The default "Open" filter drops it; it now appears under "Reviewing".
    await expect(row).toHaveCount(0);
    await admin.getByLabel('Status', { exact: true }).selectOption('REVIEWING');
    await expect(row.getByLabel('Report status')).toHaveValue('REVIEWING');
  });

  test('a customer with zero helmets signs in with the Customer ID', async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, z.customerId, Z_PASSWORD);
    await page.goto(`${PORTAL}/app/account`);
    await expect(page.getByTestId('customer-id')).toContainText(z.customerId);
    await page.goto(`${PORTAL}/app/helmets`);
    await expect(page.getByTestId('helmet-card')).toHaveCount(0);
    await page.context().close();
    await customer.context().close();
    await admin.context().close();
  });
});
