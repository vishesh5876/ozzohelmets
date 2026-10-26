import {
  type APIRequestContext,
  type Browser,
  type BrowserContextOptions,
  devices,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from '@playwright/test';

/**
 * Phase 8 acceptance: the first-time journey as one guided flow, the "skipped setup" state, the
 * emergency page on small and large phones and under poor network conditions, a mobile layout
 * audit of the portal and the admin operational views (Activation PIN state, batch workflow).
 * Device profiles are Chromium emulations (viewport, touch, user agent), not real Safari.
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';
const PORTAL = process.env.E2E_PORTAL_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';

const run = Date.now().toString(36);
const PASSWORD = 'phase eight rider';
const OWNER = 'Meera Acceptance';

interface Helmet {
  helmetCode: string;
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

/** A dedicated acceptance batch (TEST-ACCEPTANCE style): never real customer helmets. */
async function manufacture(api: APIRequestContext, quantity: number): Promise<Helmet[]> {
  const auth = await adminAuth(api);
  const model = await api.post(`${API}/admin/helmet-models`, {
    headers: auth,
    data: { name: `P8 Acceptance ${run}`, sku: `P8-${run.toUpperCase()}`, brand: 'Ozzo' },
  });
  const batch = await api.post(`${API}/admin/batches`, {
    headers: auth,
    data: {
      helmetModelId: (await model.json()).data.id,
      quantity,
      manufacturingDate: new Date().toISOString().slice(0, 10),
      notes: 'Phase 8 acceptance test batch',
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
  return csv
    .trim()
    .split('\r\n')
    .slice(1)
    .map((line) => {
      const [helmetCode, , , , qrUrl, pin, safetyCode] = line.split(',');
      return {
        helmetCode: helmetCode!,
        safetyCode: safetyCode!,
        qrUrl: qrUrl!,
        token: qrUrl!.split('/e/')[1]!,
        pin: pin!,
      };
    });
}

const phone = async (browser: Browser, profile: BrowserContextOptions = devices['Pixel 7']) =>
  (await browser.newContext({ ...profile })).newPage();

/** True when the page scrolls sideways (the classic broken-mobile-layout symptom). */
const overflowsX = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

test.describe.serial('Phase 8: production acceptance journey', () => {
  let helmets: Helmet[];
  let owner: Page;

  test.beforeAll(async () => {
    const api = await playwrightRequest.newContext();
    helmets = await manufacture(api, 2);
  });

  test('activation is one guided flow with a progress indicator and a factual summary', async ({
    browser,
  }) => {
    const h = helmets[0]!;
    owner = await phone(browser);
    await owner.goto(h.qrUrl);
    await owner.getByRole('link', { name: 'Activate Safety ID' }).click();
    await expect(owner.getByTestId('setup-progress')).toContainText(
      'Step 1 of 6: Verify Safety ID',
    );

    await owner.fill('#pin', '000000');
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(
      owner.getByText('The Activation PIN could not be verified.', { exact: false }),
    ).toBeVisible();

    await owner.fill('#pin', h.pin);
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(owner.getByTestId('setup-progress')).toContainText('Step 2 of 6: Create account');
    await owner.fill('#reg-email', `p8.${run}@example.com`);
    await owner.fill('#reg-mobile', '98765 00000');
    await owner.fill('#reg-new', PASSWORD);
    await owner.fill('#reg-confirm', PASSWORD);
    await owner.getByRole('button', { name: 'Activate Safety ID' }).click();

    await expect(owner.getByText('It is not your Activation PIN.', { exact: false })).toBeVisible();
    await owner.getByTestId('recovery-saved').check();
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(owner.getByTestId('activation-done')).toContainText('Not enabled yet');
    await owner.getByRole('button', { name: 'Complete emergency setup' }).click();

    await expect(owner.getByTestId('setup-progress')).toContainText(
      'Step 3 of 6: Emergency details',
    );
    await owner.fill('#p-name', OWNER);
    await owner.selectOption('#p-blood', 'B_NEGATIVE');
    await owner.fill('#p-conditions', 'Type 1 diabetes');
    await owner.fill('#p-allergies', 'Peanuts');
    await owner.fill('#p-meds', 'Insulin');
    await owner.getByRole('button', { name: 'Save and continue' }).click();

    await expect(owner.getByTestId('setup-progress')).toContainText(
      'Step 4 of 6: Emergency contact',
    );
    await owner.getByRole('button', { name: 'Add emergency contact' }).click();
    await owner.fill('#c-name-new', 'Rajesh Kumar');
    await owner.fill('#c-rel-new', 'Father');
    await owner.fill('#c-phone-new', '98123 40008');
    await owner.getByRole('button', { name: 'Add contact' }).click();
    await owner.getByRole('button', { name: 'Continue' }).click();

    await expect(owner.getByTestId('setup-progress')).toContainText('Step 5 of 6: Privacy');
    for (const key of [
      'showName',
      'showBloodGroup',
      'showMedicalConditions',
      'showAllergies',
      'showMedications',
      'showEmergencyContacts',
    ]) {
      const toggle = owner.getByTestId(`vis-${key}`);
      // Click the visible row (as a user would); the input itself is visually hidden.
      if (!(await toggle.isChecked())) await owner.locator('label').filter({ has: toggle }).click();
      await expect(toggle).toBeChecked();
    }
    await owner.getByRole('button', { name: 'Save and continue' }).click();
    await owner.getByRole('button', { name: 'Looks good' }).click();
    await expect(owner.getByTestId('setup-progress')).toContainText('Step 6 of 6: Finish');
    await owner.getByRole('button', { name: 'Turn on emergency profile' }).click();

    const done = owner.getByTestId('setup-complete');
    await expect(
      done.getByRole('heading', { name: 'Emergency information is active' }),
    ).toBeVisible();
    await expect(done).toContainText(h.helmetCode);
    await expect(done).toContainText('Emergency SharingOn');
    await expect(done).toContainText('Emergency contacts1');
    await expect(done.getByRole('link', { name: 'View emergency page' })).toHaveAttribute(
      'href',
      h.qrUrl,
    );
    expect(await overflowsX(owner)).toBe(false);

    await done.getByRole('link', { name: 'Go to dashboard' }).click();
    await expect(owner.getByTestId('protection-status')).toContainText(
      'Emergency information is active',
    );
  });

  test('emergency page: facts in priority order, large call buttons with the number', async ({
    browser,
  }) => {
    for (const profile of [
      devices['iPhone SE'],
      devices['Pixel 7'],
      devices['iPhone 15 Pro Max'],
    ]) {
      const scan = await phone(browser, profile);
      const started = Date.now();
      await scan.goto(helmets[0]!.qrUrl);
      await expect(scan.getByText(OWNER)).toBeVisible();
      const loadMs = Date.now() - started;
      expect(loadMs).toBeLessThan(5000);

      const headings = (await scan.locator('main h3').allTextContents()).map((t) => t.trim());
      const order = ['Name', 'Blood group', 'Medical conditions', 'Allergies', 'Medications'].map(
        (t) => headings.indexOf(t),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(headings.indexOf('Emergency contact')).toBeGreaterThan(order.at(-1)!);

      const call = scan.getByRole('link', { name: /^Call Rajesh/ });
      await expect(call).toHaveAttribute('href', 'tel:+919812340008');
      await expect(call).toContainText('+919812340008');
      const box = (await call.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(56);
      await expect(scan.getByText('Provided by the owner', { exact: true })).toBeVisible();
      await expect(scan.getByRole('link', { name: /Call emergency services/ })).toBeVisible();
      // Person-focused: no product identity; the Safety ID sits below the emergency facts.
      const body = await scan.locator('main').innerText();
      expect(body).not.toContain(helmets[0]!.helmetCode);
      expect(body.indexOf(helmets[0]!.safetyCode)).toBeGreaterThan(body.indexOf('Rajesh Kumar'));
      expect(await overflowsX(scan)).toBe(false);
      await scan.context().close();
    }
  });

  test('emergency page under a slow connection and with the API unreachable', async ({
    browser,
  }) => {
    const slow = await phone(browser);
    const cdp = await slow.context().newCDPSession(slow);
    await cdp.send('Network.enable');
    // Roughly "slow 3G": 400 ms RTT, 400 kbit/s down.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
    });
    const started = Date.now();
    await slow.goto(helmets[0]!.qrUrl);
    // The call bar is static HTML, usable before any data arrives.
    await expect(slow.getByRole('link', { name: /Call emergency services/ })).toBeVisible();
    await expect(slow.getByText(OWNER)).toBeVisible({ timeout: 20_000 });
    test.info().annotations.push({
      type: 'slow-3g-load-ms',
      description: String(Date.now() - started),
    });
    await slow.context().close();

    // API unreachable: the proxy serves the static client page instead of the server-rendered one
    // (nginx @emergency_fallback), whose own API call then fails too.
    const down = await phone(browser);
    await down.route(/\/e\/[^/]+$/, async (route) =>
      route.fulfill({ response: await route.fetch({ url: `${PORTAL}/emergency.html` }) }),
    );
    await down.route('**/api/v1/public/emergency/**', (route) => route.abort('connectionfailed'));
    await down.goto(helmets[0]!.qrUrl);
    await expect(down.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 20_000 });
    await expect(down.getByRole('link', { name: /Call emergency services/ })).toBeVisible();
    await down.context().close();
  });

  test('skipping setup leaves the helmet ACTIVATED and the dashboard says so', async ({
    browser,
  }) => {
    const h = helmets[1]!;
    const page = await phone(browser);
    await page.goto(h.qrUrl);
    await page.getByRole('link', { name: 'Activate Safety ID' }).click();
    await page.fill('#pin', h.pin);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.fill('#reg-email', `p8.skip.${run}@example.com`);
    await page.fill('#reg-mobile', '98765 00000');
    await page.fill('#reg-new', PASSWORD);
    await page.fill('#reg-confirm', PASSWORD);
    await page.getByRole('button', { name: 'Activate Safety ID' }).click();
    await page.getByTestId('recovery-saved').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('link', { name: 'Do it later' }).click();

    const status = page.getByTestId('protection-status');
    await expect(status).toContainText('Emergency information is not active yet.');
    await expect(status.getByRole('link', { name: 'Complete emergency setup' })).toBeVisible();
    await expect(page.getByTestId('helmet-card')).toContainText('Emergency sharing off');
    await expect(page.getByTestId('helmet-card')).toContainText('Activated');

    // Public scan: no personal data until the owner finishes setup.
    const scan = await phone(browser);
    await scan.goto(h.qrUrl);
    await expect(scan.getByText(/has not shared emergency information/)).toBeVisible();
    await scan.context().close();
    await page.context().close();
  });

  test('mobile layout audit: no horizontal overflow on customer pages (360 px)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      ...devices['Pixel 7'],
      viewport: { width: 360, height: 740 },
    });
    // Reuse the signed-in owner's session cookie for the narrow context.
    await ctx.addCookies(await owner.context().cookies());
    const page = await ctx.newPage();
    for (const path of [
      '/app',
      '/app/helmets',
      '/app/profile',
      '/app/contacts',
      '/app/privacy',
      '/app/warranty',
      '/app/account',
    ]) {
      await page.goto(`${PORTAL}${path}`);
      await expect(page.locator('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await overflowsX(page), `horizontal overflow on ${path}`).toBe(false);
    }
    await page.getByRole('link', { name: 'My helmets' }).first().click();
    await page
      .getByTestId('helmet-card')
      .first()
      .getByRole('link', { name: 'View helmet' })
      .click();
    for (const section of ['Safety ID', 'Identity', 'Ownership', 'Lifecycle'])
      await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
    expect(await overflowsX(page)).toBe(false);
    await ctx.close();
  });

  test('admin: Activation PIN state, batch workflow and one-box helmet search', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`${ADMIN_URL}/login`);
    await page.fill('#email', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('system-status')).toBeVisible();
    await page.goto(`${ADMIN_URL}/helmets`);
    await page.getByLabel('Search helmets').fill(`p8.${run}@example.com`);
    await page.getByRole('link', { name: helmets[0]!.helmetCode }).click();
    await expect(page.getByTestId('pin-state')).toContainText('Consumed');

    await page.getByRole('link', { name: /^BAT-/ }).first().click();
    const workflow = page.getByTestId('batch-workflow');
    await expect(workflow).toContainText('Print labels & mark printed');
    await expect(workflow).toContainText('Labels are printed and PIN escrow is purged.');
    await expect(page.getByTestId('export-status')).toContainText('1 · last');
    await expect(page.getByTestId('batch-stats')).toContainText('Activated2');
  });
});
