import { join } from 'node:path';
import {
  type Browser,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from '@playwright/test';

/**
 * Print Designs: an admin uploads Safety ID artwork, previews it, activates it, generates a batch
 * that binds the design version, creates a PNG v2, and old/new batches keep their own versions.
 * Low-resolution PNG and malicious SVG uploads are refused.
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';
const FIX = join(__dirname, '../fixtures');
const run = Date.now().toString(36);
const DESIGN = `E2E Emergency ${run}`;

async function adminPage(browser: Browser) {
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  ).newPage();
  await page.goto(`${ADMIN_URL}/login`);
  await page.fill('#email', ADMIN_EMAIL);
  await page.fill('#password', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('system-status')).toBeVisible();
  return page;
}

async function newBatch(admin: Page, quantity: string, expectDesign: RegExp) {
  await admin.goto(`${ADMIN_URL}/safety-id-batches`);
  await admin.getByRole('button', { name: 'New Safety ID batch' }).click();
  await admin.fill('#sib-qty', quantity);
  await expect(admin.locator('#sib-design option:checked')).toHaveText(expectDesign);
  await admin.getByRole('button', { name: 'Create and generate' }).click();
  await expect(admin.getByTestId('batch-print-design')).toBeVisible();
  return admin.url();
}

test.describe.serial('Print Designs: admin-controlled Safety ID artwork', () => {
  let admin: Page;
  let v1Url = '';
  let batchV1 = '';

  test.beforeAll(async ({ browser }) => {
    admin = await adminPage(browser);
  });

  test('1–2: admin opens Print Designs and uploads an SVG', async () => {
    await admin.getByRole('link', { name: 'Print Designs' }).click();
    await expect(admin.getByRole('heading', { name: 'Print Designs' })).toBeVisible();
    await admin.getByRole('button', { name: 'Create Design' }).click();
    await admin.fill('#pd-name', DESIGN);
    await admin.setInputFiles('#pd-base', join(FIX, 'design-v1.svg'));
    await expect(admin.getByTestId('pd-base-file')).toContainText('VECTOR');
    await expect(admin.getByTestId('pd-base-file')).toContainText('Best print quality');
    await admin.getByRole('button', { name: 'Save Draft' }).click();
    await expect(admin.getByRole('heading', { name: `${DESIGN} · v1` })).toBeVisible();
    v1Url = admin.url();
  });

  test('3: preview the unit (with guides) and the 12 × 18 sheet', async () => {
    await expect(admin.getByRole('img', { name: 'Safety ID unit preview' }).first()).toBeVisible();
    await expect(admin.getByText('Protected target (PIN + QR)')).toBeVisible();
    await admin.getByRole('button', { name: 'Preview Sheet' }).click();
    await expect(admin.getByRole('img', { name: '12 × 18 sheet preview' })).toBeVisible();
    await admin.keyboard.press('Escape');
  });

  test('4: activate the design', async () => {
    await admin.getByRole('button', { name: 'Activate Design' }).click();
    await expect(admin.getByText('Active', { exact: true })).toBeVisible();
  });

  test('5–7: a new batch selects the active design; the batch shows it and previews it', async () => {
    batchV1 = await newBatch(admin, '2', new RegExp(`${DESIGN} v1 \\(Active\\)`));
    await expect(admin.getByTestId('batch-design-version')).toHaveText('1');
    await expect(admin.getByTestId('batch-print-design')).toContainText('SVG / Vector');
    await admin.getByTestId('batch-print-design').getByRole('button', { name: 'Preview' }).click();
    await expect(
      admin.getByTestId('batch-print-design').getByRole('img', { name: 'Safety ID unit preview' }),
    ).toBeVisible();
    // The production PDF for this batch carries the SVG as vector artwork.
    const api = await playwrightRequest.newContext();
    const login = await api.post(`${API}/admin/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const auth = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
    const id = batchV1.split('/').pop()!;
    await expect
      .poll(
        async () =>
          (await (await api.get(`${API}/admin/safety-id-batches/${id}`, { headers: auth })).json())
            .data.generationStatus,
        { timeout: 60_000 },
      )
      .toBe('COMPLETED');
    const pdf = await api.get(`${API}/admin/safety-id-batches/${id}/export/print.pdf`, {
      headers: auth,
    });
    expect(pdf.ok()).toBeTruthy();
    const raw = (await pdf.body()).toString('latin1');
    expect(raw).toContain('/Subtype /Form');
    expect(raw).not.toContain('/Subtype /Image');
    await api.dispose();
  });

  test('8–9: create V2 with a PNG and activate it', async () => {
    await admin.goto(v1Url);
    await expect(admin.getByTestId('design-locked')).toBeVisible();
    await admin.setInputFiles('#pd-base', join(FIX, 'design-v2-2700x600.png'));
    await expect(admin.getByTestId('pd-base-file')).toContainText('600 DPI');
    await expect(admin.getByTestId('pd-base-file')).toContainText('Excellent');
    await admin.getByRole('button', { name: 'Save as New Version' }).click();
    await expect(admin.getByRole('heading', { name: `${DESIGN} · v2` })).toBeVisible();
    await admin.getByRole('button', { name: 'Activate Design' }).click();
    await expect(admin.getByText('Active', { exact: true })).toBeVisible();
  });

  test('10: the old batch remains on V1', async () => {
    await admin.goto(batchV1);
    await expect(admin.getByTestId('batch-design-version')).toHaveText('1');
  });

  test('11: a new batch uses V2', async () => {
    await newBatch(admin, '1', new RegExp(`${DESIGN} v2 \\(Active\\)`));
    await expect(admin.getByTestId('batch-design-version')).toHaveText('2');
    await expect(admin.getByTestId('batch-print-design')).toContainText('PNG / Raster');
  });

  test('12: a low-resolution PNG is rejected', async () => {
    await admin.goto(`${ADMIN_URL}/print-designs/new`);
    await admin.setInputFiles('#pd-base', join(FIX, 'low-res-990x220.png'));
    await expect(admin.getByText(/prints at 220 DPI/)).toBeVisible();
    await expect(admin.getByTestId('pd-base-file')).toHaveCount(0);
  });

  test('13: a malicious SVG is rejected', async () => {
    await admin.setInputFiles('#pd-base', {
      name: 'evil.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 100"><script>fetch("https://evil.example")</script></svg>',
      ),
    });
    await expect(admin.getByText(/scripts are not allowed/)).toBeVisible();
    await expect(admin.getByTestId('pd-base-file')).toHaveCount(0);
  });

  test.afterAll(async () => {
    // Leave no active test design behind for other journeys.
    const api = await playwrightRequest.newContext();
    const login = await api.post(`${API}/admin/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const auth = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
    const list = (await (await api.get(`${API}/admin/print-designs`, { headers: auth })).json())
      .data as { id: string; name: string; status: string }[];
    for (const d of list.filter((x) => x.name === DESIGN && x.status === 'ACTIVE'))
      await api.post(`${API}/admin/print-designs/${d.id}/archive`, { headers: auth });
    await api.dispose();
  });
});
