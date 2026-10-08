import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  type APIRequestContext,
  devices,
  expect,
  request as playwrightRequest,
  test,
} from '@playwright/test';

/**
 * Phase 6 journey: public scans → worker run (aggregation + risk evaluation) → admin analytics,
 * helmet detail with explainable signals, alert workflow and QR integrity → owner's neutral scan
 * summary → public pages still available. No dealer/partner steps; nothing is labelled counterfeit.
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';
const PORTAL = process.env.E2E_PORTAL_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';
const SCANS = Number(process.env.E2E_P6_SCANS ?? 60); // > RISK_HIGH_SCAN_HOURLY (50 by default)

const run = Date.now().toString(36);
const EMAIL = `p6.${run}@example.com`;
const PASSWORD = 'phase six rider one';
const OWNER = 'Meera Phase';

async function adminAuth(api: APIRequestContext) {
  const login = await api.post(`${API}/admin/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  return { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
}

async function manufactureOne(api: APIRequestContext) {
  const auth = await adminAuth(api);
  const model = await api.post(`${API}/admin/helmet-models`, {
    headers: auth,
    data: { name: `P6 Model ${run}`, sku: `P6-${run.toUpperCase()}`, brand: 'Ozzo' },
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
  return { helmetCode: helmetCode!, token: qrUrl!.split('/e/')[1]!, pin: pin! };
}

/** Runs the scheduled jobs once, exactly as ops would (`node dist/worker.js --once all`). */
function runWorkerOnce(): string {
  const apiDir = resolve(__dirname, '../../apps/api');
  return execFileSync(
    'npx',
    ['dotenv', '-e', '../../.env', '--', 'node', 'dist/worker.js', '--once', 'all'],
    {
      cwd: apiDir,
      encoding: 'utf8',
      timeout: 90_000,
    },
  );
}

test.describe.serial('Phase 6: QR analytics, review signals and alert workflow', () => {
  let helmet: { helmetCode: string; token: string; pin: string };
  let helmetId: string;

  test.beforeAll(async () => {
    const api = await playwrightRequest.newContext();
    helmet = await manufactureOne(api);
    const reg = await api.post(`${API}/customer/activation/register`, {
      data: { helmetCode: helmet.helmetCode, pin: helmet.pin, email: EMAIL, password: PASSWORD },
    });
    expect(reg.ok()).toBeTruthy();
    const auth = { Authorization: `Bearer ${(await reg.json()).data.accessToken}` };
    await api.put(`${API}/customer/emergency-profile`, {
      headers: auth,
      data: { name: OWNER, bloodGroup: 'B_POSITIVE', allergies: ['Latex'] },
    });
    await api.post(`${API}/customer/emergency-contacts`, {
      headers: auth,
      data: { name: 'Arjun Phase', relationship: 'Brother', phone: '+919812300006' },
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
    helmetId = (await (await api.get(`${API}/customer/helmets`, { headers: auth })).json()).data[0]
      .id;
    await api.post(`${API}/customer/helmets/${helmetId}/emergency/enable`, { headers: auth });
    // A burst of public scans (distinct browsers on one network, e.g. a group ride).
    for (let i = 0; i < SCANS; i++) {
      const res = await api.get(`${API}/public/emergency/${helmet.token}`, {
        headers: {
          'User-Agent': `Mozilla/5.0 (Linux; Android 14; Pixel ${i}) Mobile Safari/537.36`,
        },
      });
      expect(res.status()).toBe(200);
    }
    const out = runWorkerOnce();
    expect(out).toContain('analytics.aggregate: SUCCEEDED');
    expect(out).toContain('risk.evaluate: SUCCEEDED');
    expect(out).toContain('retention.cleanup: SUCCEEDED');
  });

  test('admin reviews analytics, the helmet signal and works the alert', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/login`);
    await page.fill('#email', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: 'Analytics', exact: true }).click();
    await expect(page.getByTestId('analytics-overview')).toBeVisible();
    await expect(page.getByTestId('chart-scans')).toBeVisible();

    await page.getByRole('link', { name: 'QR scans' }).click();
    await expect(page.getByTestId('scan-analytics')).toContainText(helmet.helmetCode);

    await page.getByRole('link', { name: 'Helmet activity' }).click();
    await expect(page.getByTestId('risk-disclaimer')).toContainText('does not prove');
    const row = page.getByTestId('activity-row').filter({ hasText: helmet.helmetCode });
    await expect(row).toContainText('review priority');
    await row.getByRole('link', { name: helmet.helmetCode }).click();

    const detail = page.getByTestId('helmet-analytics');
    await expect(detail.getByTestId('risk-signal').first()).toContainText('High scan volume');
    await expect(detail.getByTestId('risk-reasons')).toContainText(`public scans in 1 hour`);
    // Only the disclaimer mentions counterfeits ("does not prove…"); signals and alerts never accuse.
    for (const part of [
      detail.getByTestId('risk-reasons'),
      detail.getByTestId('risk-alert').first(),
    ])
      await expect(part).not.toContainText(/counterfeit|fake|fraud/i);
    await expect(page.getByTestId('chart-helmet-scans')).toBeVisible();
    await page
      .getByTestId('chart-helmet-scans')
      .getByRole('button', { name: 'Show table' })
      .click();
    await expect(page.getByTestId('chart-helmet-scans').getByRole('table')).toBeVisible();

    const alert = detail.getByTestId('risk-alert').first();
    await expect(alert).toContainText('High public scan volume');
    await alert.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(alert.getByTestId('alert-status')).toHaveText('Acknowledged');
    await alert.getByRole('button', { name: 'Assign to me' }).click();
    await expect(alert).toContainText('Assignee: Super Admin');
    await alert.getByLabel('Resolution reason').fill('Group ride: many riders scanned the helmet');
    await alert.getByRole('button', { name: 'Resolve' }).click();
    await expect(alert.getByTestId('alert-status')).toHaveText('Resolved');

    // QR integrity is a human decision, separate from the lifecycle status.
    const panel = page.getByTestId('qr-integrity-panel');
    await panel.getByLabel('QR integrity status').selectOption('UNDER_REVIEW');
    await panel.getByLabel('Note').fill('Checking the printed sticker with the owner');
    await panel.getByRole('button', { name: 'Save QR integrity' }).click();
    await expect(detail.getByTestId('qr-integrity')).toHaveText('QR under review');

    await page.goto(`${ADMIN_URL}/analytics/alerts`);
    await page.getByLabel('Alert status').selectOption('RESOLVED');
    await expect(
      page.getByTestId('risk-alert').filter({ hasText: helmet.helmetCode }),
    ).toContainText('Group ride');
  });

  test('owner sees a neutral scan summary; public pages stay available', async ({ browser }) => {
    const phone = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
    await phone.goto(`${PORTAL}/login`);
    await phone.fill('#login-identifier', EMAIL);
    await phone.fill('#login-password', PASSWORD);
    await phone.getByRole('button', { name: 'Sign in' }).click();
    await phone.getByTestId('helmet-card').filter({ hasText: helmet.helmetCode }).click();
    const summary = phone.getByTestId('scan-summary');
    await expect(summary).toContainText(
      /Your helmet QR was accessed \d+ times in the last 30 days\./,
    );
    await expect(summary).not.toContainText(/IP|device|location|risk|suspicious/i);

    // Emergency page works even with a review signal and the QR under review.
    await phone.goto(`${PORTAL}/e/${helmet.token}`);
    await expect(phone.getByText(OWNER)).toBeVisible();
    await expect(phone.getByText('Latex')).toBeVisible();

    // COMPROMISED adds a neutral notice on the verification page only.
    const api = await playwrightRequest.newContext();
    const auth = await adminAuth(api);
    const set = (status: string, note: string) =>
      api.patch(`${API}/admin/analytics/helmets/${helmet.helmetCode}/qr-integrity`, {
        headers: auth,
        data: { status, note },
      });
    expect((await set('COMPROMISED', 'Owner confirmed a copied sticker')).ok()).toBeTruthy();
    await phone.goto(`${PORTAL}/verify/${helmet.token}`);
    await expect(phone.getByText('✓ Product identity verified')).toBeVisible();
    const notice = phone.getByRole('status').filter({ hasText: 'possibly copied' });
    await expect(notice).toContainText('Please contact support');
    await expect(notice).not.toContainText(/counterfeit|fake|fraud/i);
    await phone.goto(`${PORTAL}/e/${helmet.token}`);
    await expect(phone.getByText(OWNER)).toBeVisible();
    expect((await set('NORMAL', 'Replacement sticker issued')).ok()).toBeTruthy();
  });
});
