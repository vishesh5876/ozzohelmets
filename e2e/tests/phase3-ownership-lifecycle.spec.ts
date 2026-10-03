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
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';

const run = Date.now().toString(36).toUpperCase();
const A_PASSWORD = 'first owner rides north';
const B_PASSWORD = 'second owner rides south';
const A_NAME = 'Asha Verma';
const B_NAME = 'Bilal Khan';

interface Helmet {
  id: string;
  helmetCode: string;
  qrUrl: string;
  pin: string;
}

/** Manufactures `count` SOLD helmets through the real admin API (export gives the PINs). */
async function manufacture(api: APIRequestContext, count: number): Promise<Helmet[]> {
  const login = await api.post(`${API}/admin/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const auth = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
  const model = await api.post(`${API}/admin/helmet-models`, {
    headers: auth,
    data: { name: `P3 Roadster ${run}`, sku: `P3-${run}`, brand: 'Ozzo' },
  });
  const batch = await api.post(`${API}/admin/batches`, {
    headers: auth,
    data: {
      helmetModelId: (await model.json()).data.id,
      quantity: count,
      manufacturingDate: '2026-09-01',
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

async function onboard(page: Page, name: string, allergy: string, contact: string) {
  await page.goto(`${PORTAL}/app/onboarding`);
  await page.fill('#p-name', name);
  await page.selectOption('#p-blood', 'B_POSITIVE');
  await page.fill('#p-allergies', allergy);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('button', { name: 'Add emergency contact' }).click();
  await page.fill('#c-name-new', contact);
  await page.fill('#c-rel-new', 'Sibling');
  await page.fill('#c-phone-new', '98123 45678');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByText(contact)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  for (const key of ['showName', 'showBloodGroup', 'showAllergies', 'showEmergencyContacts'])
    await page.getByTestId(`vis-${key}`).check({ force: true });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('button', { name: 'Looks good' }).click();
  await page.getByRole('button', { name: 'Turn on emergency profile' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your helmet emergency profile is active.' }),
  ).toBeVisible();
}

test.describe.serial('Phase 3: transfer → new owner → lost/stolen/damaged → retire', () => {
  let helmet: Helmet; // transferred
  let keep: Helmet; // stays with A
  let a: Page;
  let b: Page;
  let transferCode: string;

  test.beforeAll(async () => {
    const api = await playwrightRequest.newContext();
    const made = await manufacture(api, 2);
    helmet = made[0]!;
    keep = made[1]!;
    // Customer A: account via the first helmet, adds the second, enables emergency info on the first.
    const reg = await api.post(`${API}/customer/activation/register`, {
      data: {
        helmetCode: helmet.helmetCode,
        pin: helmet.pin,
        password: A_PASSWORD,
        name: A_NAME,
      },
    });
    expect(reg.ok()).toBeTruthy();
    const auth = { Authorization: `Bearer ${(await reg.json()).data.accessToken}` };
    const add = await api.post(`${API}/customer/activation/add-helmet`, {
      headers: auth,
      data: { helmetCode: keep.helmetCode, pin: keep.pin },
    });
    expect(add.ok()).toBeTruthy();
    await api.put(`${API}/customer/emergency-profile`, {
      headers: auth,
      data: { name: A_NAME, bloodGroup: 'A_POSITIVE', allergies: ['Peanuts'] },
    });
    await api.post(`${API}/customer/emergency-contacts`, {
      headers: auth,
      data: { name: 'Ravi Verma', relationship: 'Brother', phone: '+919812300001' },
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

  test('1–3: customer A signs in, sees the active helmet and opens it', async ({ browser }) => {
    a = await (await browser.newContext()).newPage();
    await signIn(a, helmet.helmetCode, A_PASSWORD);
    await a.goto(`${PORTAL}/app/helmets`);
    await expect(a.getByRole('heading', { name: 'Active' })).toBeVisible();
    const card = a.getByTestId('helmet-card').filter({ hasText: helmet.helmetCode });
    await expect(card).toContainText('Profile active');
    await card.getByRole('link', { name: 'View' }).click();
    await expect(a.getByRole('heading', { name: helmet.helmetCode })).toBeVisible();
    const { text } = await scan(browser, helmet.qrUrl);
    expect(text).toContain(A_NAME);
  });

  test('4–7: A starts a transfer, confirms the password, gets a one-time code, signs out', async () => {
    await a.getByTestId('helmet-actions').getByRole('link', { name: 'Transfer' }).click();
    await expect(a.getByRole('heading', { name: 'Transfer this helmet' })).toBeVisible();
    await a.fill('#confirm-password', A_PASSWORD);
    await a.getByRole('button', { name: 'Confirm password' }).click();
    await a.getByRole('button', { name: 'Generate transfer code' }).click();
    transferCode = (await a.getByTestId('transfer-code').innerText()).trim();
    expect(transferCode).toMatch(/^TR-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await expect(a.getByTestId('transfer-countdown')).toHaveText(/^(29|30):\d\d$/);
    await a.goto(`${PORTAL}/app/account`);
    // The last "Sign out" signs out this device (others are per-session buttons in the list).
    await a.getByRole('button', { name: 'Sign out', exact: true }).last().click();
    await expect(a).not.toHaveURL(/\/app(\/|$)/);
    await a.goto(`${PORTAL}/app`);
    await expect(a.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('8–13: a new customer claims with Helmet ID + code, creates an account, saves the recovery code', async ({
    browser,
  }) => {
    b = await (await browser.newContext()).newPage();
    await b.goto(`${PORTAL}/claim`);
    await b.fill('#claim-helmet', helmet.helmetCode.toLowerCase());
    await b.fill('#claim-code', transferCode.toLowerCase().replaceAll('-', ' '));
    await b.getByRole('button', { name: 'Continue' }).click();
    await expect(b.getByText(helmet.helmetCode)).toBeVisible();
    await b.getByRole('button', { name: 'New customer' }).click();
    await b.fill('#claim-name', B_NAME);
    await b.fill('#claim-new', B_PASSWORD);
    await b.fill('#claim-confirm', B_PASSWORD);
    await b.getByRole('button', { name: 'Create account and claim' }).click();
    await expect(
      b.getByText('Save this recovery code. It can be used if you forget your password.'),
    ).toBeVisible();
    expect((await b.getByTestId('recovery-code').innerText()).trim()).toMatch(/^RK-/);
    await b.getByTestId('recovery-saved').check();
    await b.getByRole('button', { name: 'Go to my helmet' }).click();
    await expect(b.getByRole('heading', { name: helmet.helmetCode })).toBeVisible();
    await expect(b.getByTestId('timeline')).toContainText('Received by transfer');
    await b.goto(`${PORTAL}/app/helmets`);
    await expect(b.getByTestId('helmet-card').filter({ hasText: helmet.helmetCode })).toBeVisible();
  });

  test('14–15: A no longer controls the helmet; the public page shows none of A’s data', async ({
    browser,
  }) => {
    await signIn(a, keep.helmetCode, A_PASSWORD);
    await a.goto(`${PORTAL}/app/helmets`);
    await expect(a.getByTestId('helmet-card')).toHaveCount(1);
    await expect(a.getByTestId('helmet-card')).toContainText(keep.helmetCode);
    await a.goto(`${PORTAL}/app/helmets/${helmet.id}`);
    await expect(a.getByText('Helmet not found.')).toBeVisible();
    const { page, text } = await scan(browser, helmet.qrUrl);
    expect(text).toContain('has not shared emergency information');
    expect(text).not.toContain(A_NAME);
    expect(text).not.toContain('Peanuts');
    await page.context().close();
  });

  test('16–17: B sets up and enables their own profile; the public page shows B’s data', async ({
    browser,
  }) => {
    await onboard(b, B_NAME, 'Latex', 'Sara Khan');
    const { page, text } = await scan(browser, helmet.qrUrl);
    expect(text).toContain(B_NAME);
    expect(text).toContain('Latex');
    expect(text).not.toContain(A_NAME);
    await page.context().close();
  });

  test('18–21: B reports lost (public shows lost), then marks found (profile returns)', async ({
    browser,
  }) => {
    await b.goto(`${PORTAL}/app/helmets/${helmet.id}`);
    await b.getByTestId('helmet-actions').getByRole('link', { name: 'Report lost' }).click();
    await expect(b.getByRole('heading', { name: 'Mark this helmet as lost?' })).toBeVisible();
    await b.getByRole('button', { name: 'Report lost' }).click();
    await expect(b.getByTestId('timeline')).toContainText('Reported lost');
    let view = await scan(browser, helmet.qrUrl);
    await expect(view.page.getByRole('heading', { level: 1, name: 'Reported lost' })).toBeVisible();
    expect(view.text).toContain('This helmet has been reported lost.');
    expect(view.text).not.toContain(B_NAME);
    await view.page.context().close();

    await b.getByTestId('helmet-actions').getByRole('link', { name: 'Mark as found' }).click();
    await b.getByRole('button', { name: 'Mark as found' }).click();
    await expect(b.getByTestId('timeline')).toContainText('Found');
    view = await scan(browser, helmet.qrUrl);
    expect(view.text).toContain(B_NAME);
    await view.page.context().close();
  });

  test('22–24: B reports stolen (password confirmed), transfer disappears, then recovers', async ({
    browser,
  }) => {
    await b.getByTestId('helmet-actions').getByRole('link', { name: 'Report stolen' }).click();
    await b.fill('#confirm-password', B_PASSWORD);
    await b.getByRole('button', { name: 'Confirm password' }).click();
    await b.getByRole('button', { name: 'Report stolen' }).click();
    await expect(b.getByTestId('timeline')).toContainText('Reported stolen');
    const actions = b.getByTestId('helmet-actions');
    await expect(actions.getByRole('link', { name: 'Transfer' })).toHaveCount(0);
    const view = await scan(browser, helmet.qrUrl);
    expect(view.text).toContain('This helmet has been reported stolen.');
    expect(view.text).not.toContain(B_NAME);
    await view.page.context().close();
    // The direct URL is refused too.
    await b.goto(`${PORTAL}/app/helmets/${helmet.id}/transfer`);
    await expect(b.getByText('This action isn’t available')).toBeVisible();
    await b.goto(`${PORTAL}/app/helmets/${helmet.id}`);
    await b.getByTestId('helmet-actions').getByRole('link', { name: 'Mark as recovered' }).click();
    // The full reload above dropped the in-memory confirmation, so the password is asked again.
    await b.fill('#confirm-password', B_PASSWORD);
    await b.getByRole('button', { name: 'Confirm password' }).click();
    await b.getByRole('button', { name: 'Mark as recovered' }).click();
    await expect(b.getByTestId('timeline')).toContainText('Recovered');
  });

  test('25–27: B marks it damaged, retires it, and the public page shows it is no longer active', async ({
    browser,
  }) => {
    await b.getByTestId('helmet-actions').getByRole('link', { name: 'Mark damaged' }).click();
    await b.selectOption('#damage-reason', 'ACCIDENT');
    await b.getByRole('button', { name: 'Mark damaged' }).click();
    await expect(b.getByTestId('timeline')).toContainText('Marked damaged · Accident');
    let view = await scan(browser, helmet.qrUrl);
    expect(view.text).toContain('This helmet is currently marked as damaged.');
    expect(view.text).not.toContain(B_NAME);
    await view.page.context().close();

    await b.getByTestId('helmet-actions').getByRole('link', { name: 'Retire helmet' }).click();
    await expect(b.getByRole('heading', { name: 'Retire this helmet permanently?' })).toBeVisible();
    const retire = b.getByRole('button', { name: 'Retire helmet' });
    await expect(retire).toBeDisabled();
    await b.fill('#retire-confirm', helmet.helmetCode);
    await retire.click();
    await expect(b.getByTestId('timeline')).toContainText('Retired');
    await b.goto(`${PORTAL}/app/helmets`);
    await expect(b.getByRole('heading', { name: 'Retired' })).toBeVisible();

    view = await scan(browser, helmet.qrUrl);
    await expect(
      view.page.getByRole('heading', { level: 1, name: 'No longer active' }),
    ).toBeVisible();
    expect(view.text).toContain('This helmet is no longer active.');
    expect(view.text).not.toContain(B_NAME);
    expect(view.text).not.toContain(A_NAME);
    await view.page.context().close();
    await a.context().close();
    await b.context().close();
  });
});
