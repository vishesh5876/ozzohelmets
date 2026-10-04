import { readFileSync } from 'node:fs';
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
 * Phase 5 journey: account management on a phone, then admin support and a SUPER_ADMIN recovery
 * grant, ending with the public emergency page still working. No dealer/partner steps.
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';
const PORTAL = process.env.E2E_PORTAL_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';

const run = Date.now().toString(36);
const EMAIL = `p5.${run}@example.com`;
const NEW_EMAIL = `p5.new.${run}@example.com`;
const PASSWORD = 'phase five rider one';
const PASSWORD_2 = 'phase five rider two';
const PASSWORD_3 = 'support helped me back';
const OWNER = 'Nisha Phase';
const ALLERGY = 'Ibuprofen';
const CONTACT = 'Karan Phase';

interface Helmet {
  helmetCode: string;
  qrUrl: string;
  pin: string;
}

async function manufactureOne(api: APIRequestContext): Promise<Helmet> {
  const login = await api.post(`${API}/admin/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const auth = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
  const model = await api.post(`${API}/admin/helmet-models`, {
    headers: auth,
    data: { name: `P5 Model ${run}`, sku: `P5-${run.toUpperCase()}`, brand: 'Ozzo' },
  });
  const batch = await api.post(`${API}/admin/batches`, {
    headers: auth,
    data: {
      helmetModelId: (await model.json()).data.id,
      quantity: 1,
      manufacturingDate: new Date().toISOString().slice(0, 10),
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
  const [helmetCode, , , , qrUrl, pin] = csv.trim().split('\r\n')[1]!.split(',');
  return { helmetCode: helmetCode!, qrUrl: qrUrl!, pin: pin! };
}

async function mobile(browser: Browser): Promise<Page> {
  return (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
}

test.describe.serial('Phase 5: account management, support view and recovery grant', () => {
  let helmet: Helmet;
  let customerId: string;
  let phone: Page;
  let otherDeviceToken: string;
  let grant: string;

  test.beforeAll(async () => {
    const api = await playwrightRequest.newContext();
    helmet = await manufactureOne(api);
    const reg = await api.post(`${API}/customer/activation/register`, {
      data: { helmetCode: helmet.helmetCode, pin: helmet.pin, email: EMAIL, password: PASSWORD },
    });
    expect(reg.ok()).toBeTruthy();
    const body = (await reg.json()).data;
    customerId = body.customer.customerId;
    const auth = { Authorization: `Bearer ${body.accessToken}` };
    await api.put(`${API}/customer/emergency-profile`, {
      headers: auth,
      data: { name: OWNER, bloodGroup: 'AB_POSITIVE', allergies: [ALLERGY] },
    });
    await api.post(`${API}/customer/emergency-contacts`, {
      headers: auth,
      data: { name: CONTACT, relationship: 'Brother', phone: '+919812300005' },
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
    const helmets = (await (await api.get(`${API}/customer/helmets`, { headers: auth })).json())
      .data;
    expect(
      (
        await api.post(`${API}/customer/helmets/${helmets[0].id}/emergency/enable`, {
          headers: auth,
        })
      ).ok(),
    ).toBeTruthy();
    // A second device, signed in separately (to be revoked from the phone).
    const other = await playwrightRequest.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/131.0',
    });
    const second = await other.post(`${API}/customer/auth/login`, {
      data: { identifier: EMAIL, password: PASSWORD },
    });
    otherDeviceToken = (await second.json()).data.accessToken;
    await api.dispose();
  });

  test('1–2: customer signs in with email; dashboard shows helmet and profile health', async ({
    browser,
  }) => {
    phone = await mobile(browser);
    await phone.goto(`${PORTAL}/login`);
    await phone.fill('#login-identifier', EMAIL);
    await phone.fill('#login-password', PASSWORD);
    await phone.getByRole('button', { name: 'Sign in' }).click();
    await expect(phone.getByTestId('helmet-card')).toContainText(helmet.helmetCode);
    await expect(phone.getByTestId('completion')).toContainText('% complete');
    await expect(phone.getByTestId('health-warnings')).toContainText('Warranty not registered');
    await expect(phone.getByText('Recent account activity')).toBeVisible();
  });

  test('3–6: account page — Customer ID, sessions, revoke another device', async () => {
    await phone.getByRole('link', { name: 'Account', exact: true }).click();
    await expect(phone.getByTestId('customer-id')).toHaveText(customerId);
    const sessions = phone.getByTestId('sessions');
    // Activation session (API), the second device and this phone.
    await expect(sessions.getByRole('listitem')).toHaveCount(3);
    await expect(sessions).toContainText('This device');
    await expect(sessions).toContainText('Firefox on Windows');
    await sessions.getByRole('button', { name: /Sign out Firefox on Windows/ }).click();
    await expect(sessions.getByRole('listitem')).toHaveCount(2);
    await expect(sessions).not.toContainText('Firefox on Windows');
    const res = await phone.request.get(`${API}/customer/auth/me`, {
      headers: { Authorization: `Bearer ${otherDeviceToken}` },
    });
    expect(res.status()).toBe(401);
  });

  test('7–8: change password, then sign in again with it', async () => {
    await phone.fill('#cp-current', PASSWORD);
    await phone.fill('#cp-new', PASSWORD_2);
    await phone.fill('#cp-confirm', PASSWORD_2);
    await phone.getByRole('button', { name: 'Change password' }).click();
    await expect(
      phone.getByText('Password changed. Your other devices were signed out.'),
    ).toBeVisible();
    await phone.getByRole('button', { name: 'Sign out', exact: true }).first().click();
    await phone.goto(`${PORTAL}/login`);
    await phone.fill('#login-identifier', EMAIL);
    await phone.fill('#login-password', PASSWORD_2);
    await phone.getByRole('button', { name: 'Sign in' }).click();
    await expect(phone.getByTestId('helmet-card')).toBeVisible();
  });

  test('9: rotate the recovery code (shown once, acknowledged)', async () => {
    await phone.goto(`${PORTAL}/app/account`);
    await expect(phone.getByTestId('recovery-status')).toContainText('Configured');
    await phone.fill('#rc-password', PASSWORD_2);
    await phone.getByRole('button', { name: 'Generate new recovery code' }).click();
    await expect(phone.getByTestId('recovery-code')).toHaveText(/^RK-/);
    await phone.getByTestId('recovery-saved').check();
    await phone.getByRole('button', { name: 'Done' }).click();
    await expect(phone.getByTestId('recovery-code')).toHaveCount(0);
    await expect(phone.getByTestId('recovery-status')).toHaveText('Recovery code: Configured');
  });

  test('10–12: update email; old email fails, new email works', async () => {
    await phone.getByRole('button', { name: 'Change email' }).click();
    await phone.fill('#ce-email', NEW_EMAIL);
    await phone.fill('#ce-confirm', NEW_EMAIL);
    await phone.fill('#ce-password', PASSWORD_2);
    await phone.getByRole('button', { name: 'Continue' }).click();
    await phone.getByRole('button', { name: 'Confirm email change' }).click();
    await expect(phone.getByTestId('account-email')).toHaveText(NEW_EMAIL);
    const old = await phone.request.post(`${API}/customer/auth/login`, {
      data: { identifier: EMAIL, password: PASSWORD_2 },
    });
    expect(old.status()).toBe(401);
    const fresh = await phone.request.post(`${API}/customer/auth/login`, {
      data: { identifier: NEW_EMAIL, password: PASSWORD_2 },
    });
    expect(fresh.status()).toBe(200);
  });

  test('13–14: request a data export and verify the download', async () => {
    await phone.getByRole('button', { name: 'Request data export' }).click();
    await phone.fill('#confirm-password', PASSWORD_2);
    await phone.getByRole('button', { name: 'Confirm password' }).click();
    const [download] = await Promise.all([
      phone.waitForEvent('download'),
      phone.getByRole('button', { name: 'Download my data (JSON)' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^helmet-account-${customerId}-.*\\.json$`),
    );
    const text = readFileSync((await download.path())!, 'utf8');
    const data = JSON.parse(text);
    expect(data.account).toMatchObject({ customerId, email: NEW_EMAIL });
    expect(data.emergencyProfile.allergies).toEqual([ALLERGY]);
    expect(data.helmets[0].helmetCode).toBe(helmet.helmetCode);
    expect(text).not.toMatch(/argon2|tokenHash|passwordHash|recoveryCodeHash/);
  });

  test('15–16: request account deletion, then cancel it', async () => {
    await phone.getByRole('button', { name: 'Request account deletion' }).click();
    await phone.fill('#del-reason', 'Testing the request flow');
    await phone.getByRole('button', { name: 'Request deletion' }).click();
    await expect(phone.getByTestId('deletion-pending')).toContainText('awaiting review');
    await phone.getByRole('button', { name: 'Cancel deletion request' }).click();
    await expect(phone.getByText('Your previous request was cancelled.')).toBeVisible();
  });

  test('17–19: admin finds the customer by email; summary shows no medical details', async ({
    browser,
  }) => {
    const admin = await (await browser.newContext()).newPage();
    await admin.goto(`${ADMIN_URL}/login`);
    await admin.fill('#email', ADMIN_EMAIL);
    await admin.fill('#password', ADMIN_PASSWORD);
    await admin.click('button[type=submit]');
    await expect(admin.getByText('Helmets by status')).toBeVisible();
    await admin.getByRole('link', { name: 'Customers' }).click();
    await admin.getByLabel('Search customers').fill(NEW_EMAIL.toUpperCase());
    await admin.getByRole('button', { name: 'Search' }).click();
    await admin.getByTestId('customer-row').getByRole('link', { name: customerId }).click();
    const summary = admin.getByTestId('customer-summary');
    await expect(summary).toContainText(NEW_EMAIL);
    await expect(summary).toContainText(customerId);
    await expect(admin.getByTestId('emergency-state')).toContainText('Enabled');
    await expect(admin.getByTestId('recovery-state')).toContainText('Configured');
    const body = await admin.locator('body').innerText();
    for (const secret of [ALLERGY, CONTACT, 'AB+', '+919812300005'])
      expect(body).not.toContain(secret);

    // 20: SUPER_ADMIN issues a one-time recovery grant.
    await admin.fill(
      '#grant-reason',
      'Customer lost password and recovery code; verified by phone',
    );
    await admin.fill('#grant-confirm', customerId);
    await admin.fill('#grant-password', ADMIN_PASSWORD);
    await admin.getByRole('button', { name: 'Issue recovery grant' }).click();
    grant = (await admin.getByTestId('grant-credential').innerText()).trim();
    expect(grant).toMatch(/^AR-[23456789A-HJ-NP-Z]{4}(-[23456789A-HJ-NP-Z]{4}){3}$/);
    await admin.getByRole('button', { name: /Done/ }).click();
    await expect(admin.getByTestId('grant-credential')).toHaveCount(0);
    await admin.context().close();
  });

  test('21–24: customer uses the grant: password reset, all sessions revoked, new code shown once', async ({
    browser,
  }) => {
    const device = await mobile(browser);
    await device.goto(`${PORTAL}/recover`);
    await device.fill('#rec-identifier', customerId);
    await device.fill('#rec-code', grant);
    await device.getByRole('button', { name: 'Continue' }).click();
    await device.fill('#reset-new', PASSWORD_3);
    await device.fill('#reset-confirm', PASSWORD_3);
    await device.getByRole('button', { name: 'Set new password' }).click();
    await expect(device.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    const code = (await device.getByTestId('recovery-code').innerText()).trim();
    expect(code).toMatch(/^RK-/);
    await device.getByTestId('recovery-saved').check();
    await device.getByRole('button', { name: 'Go to my account' }).click();
    await expect(device.getByTestId('helmet-card')).toContainText(helmet.helmetCode);
    await expect(device.getByTestId('recovery-code')).toHaveCount(0);
    // The phone's old session is gone.
    await phone.goto(`${PORTAL}/app`);
    await expect(phone.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    // The grant cannot be used twice; the old password is dead.
    const again = await device.request.post(`${API}/customer/auth/recover`, {
      data: { identifier: customerId, recoveryCode: grant },
    });
    expect(again.status()).toBe(401);
    const oldPw = await device.request.post(`${API}/customer/auth/login`, {
      data: { identifier: NEW_EMAIL, password: PASSWORD_2 },
    });
    expect(oldPw.status()).toBe(401);
    await device.context().close();
  });

  test('25: the public emergency page still works and shows only approved information', async ({
    browser,
  }) => {
    const scan = await mobile(browser);
    await scan.goto(helmet.qrUrl);
    await expect(scan.getByRole('heading', { name: 'Emergency profile' })).toBeVisible();
    await expect(scan.getByText(OWNER)).toBeVisible();
    await expect(scan.getByText(ALLERGY)).toBeVisible();
    await expect(scan.getByRole('link', { name: /Call Karan/ })).toHaveAttribute(
      'href',
      'tel:+919812300005',
    );
    await expect(scan.getByText('Provided by helmet owner')).toBeVisible();
    await expect(scan.getByRole('button', { name: 'Copy medical information' })).toBeVisible();
    await expect(scan.getByRole('button', { name: 'Print emergency information' })).toBeVisible();
    const body = await scan.locator('body').innerText();
    for (const leak of [NEW_EMAIL, customerId, helmet.pin]) expect(body).not.toContain(leak);
    await scan.context().close();
    await phone.context().close();
  });
});
