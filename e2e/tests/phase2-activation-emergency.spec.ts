import { readFileSync } from 'node:fs';
import { type Browser, devices, expect, type Page, test } from '@playwright/test';

const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';

const run = Date.now().toString(36).toUpperCase();
const SKU = `E2E-${run}`;
const OWNER = 'Asha Verma';
const PASSWORD = 'river stones at dawn';
const NEW_PASSWORD = 'quiet lanterns over hills';
const RECOVERY_CODE = /^RK-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/;

interface ManufacturedHelmet {
  helmetCode: string;
  qrUrl: string;
  pin: string;
}

async function anonymousMobilePage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  return context.newPage();
}

test.describe
  .serial('Phase 2: PIN activation → password account → emergency profile → recovery', () => {
  let helmet: ManufacturedHelmet;
  let owner: Page;
  let recoveryCode: string;

  const portal = (path: string) => new URL(path, helmet.qrUrl).toString();

  async function signIn(page: Page, password: string) {
    await page.goto(portal('/login'));
    await page.fill('#login-helmet', helmet.helmetCode.toLowerCase());
    await page.fill('#login-password', password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  test('admin manufactures a helmet and moves it to SOLD', async ({ page }) => {
    await page.goto(`${ADMIN_URL}/login`);
    await page.fill('#email', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASSWORD);
    await page.click('button[type=submit]');
    await expect(page.getByText('Helmets by status')).toBeVisible();

    // 1. Helmet model
    await page.goto(`${ADMIN_URL}/models`);
    await page.getByRole('button', { name: 'New model' }).first().click();
    await page.fill('#m-name', `E2E Roadster ${run}`);
    await page.fill('#m-sku', SKU);
    await page.fill('#m-brand', 'Ozzo');
    await page.click('dialog button[type=submit]');
    await expect(page.getByRole('cell', { name: SKU })).toBeVisible();

    // 2–3. Batch + generation
    await page.goto(`${ADMIN_URL}/batches/new`);
    await page.locator('#b-model option', { hasText: SKU }).waitFor({ state: 'attached' });
    await page.selectOption('#b-model', { label: `E2E Roadster ${run} — ${SKU}` });
    await page.fill('#b-qty', '2');
    await page.click('button[type=submit]');
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible({ timeout: 60_000 });

    // 4. Authorised manufacturing export (audited) yields the activation PIN.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const csv = readFileSync((await download.path())!, 'utf8')
      .trim()
      .split('\r\n');
    const [helmetCode, , , , qrUrl, pin] = csv[1]!.split(',');
    helmet = { helmetCode: helmetCode!, qrUrl: qrUrl!, pin: pin! };
    expect(helmet.pin).toMatch(/^[23456789A-HJ-NP-Z]{8}$/);

    // Labels printed → escrow purged; then warehouse → sold.
    await page.getByRole('button', { name: 'Mark printed' }).click();
    await page.getByRole('button', { name: 'Confirm printed' }).click();
    await expect(page.getByText('Printed', { exact: true }).first()).toBeVisible();

    await page.goto(`${ADMIN_URL}/helmets?search=${encodeURIComponent(helmet.helmetCode)}`);
    await page.getByRole('link', { name: helmet.helmetCode }).click();
    for (const status of ['IN_INVENTORY', 'SOLD']) {
      await page.selectOption('#s-status', status);
      await page.getByRole('button', { name: 'Update status' }).click();
      await expect(page.locator('#s-status')).toHaveValue('');
    }
    await expect(page.getByText('Sold', { exact: true }).first()).toBeVisible();
  });

  test('anonymous scan shows the helmet is not activated', async ({ browser }) => {
    const scan = await anonymousMobilePage(browser);
    await scan.goto(helmet.qrUrl);
    await expect(scan.getByRole('heading', { name: 'Helmet not activated' })).toBeVisible();
    await expect(scan.getByText('This helmet has not yet been activated.')).toBeVisible();
    await expect(scan.getByRole('link', { name: /Call emergency/ })).toHaveAttribute(
      'href',
      /^tel:/,
    );
    // The emergency page is the lightweight standalone entry, not the React app.
    expect(await scan.evaluate(() => document.querySelector('#root'))).toBeNull();
    await scan.context().close();
  });

  test('customer activates with the PIN and creates a password', async ({ browser }) => {
    owner = await anonymousMobilePage(browser);
    await owner.goto(helmet.qrUrl);
    await owner.getByRole('link', { name: 'Activate helmet' }).click();
    await expect(owner.getByText('Helmet identified from its QR code')).toBeVisible();

    // PIN = proof of possession (preliminary check, nothing consumed yet).
    await owner.fill('#pin', helmet.pin.toLowerCase());
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(owner.getByText(/PIN accepted/)).toBeVisible();
    await expect(owner.getByText(helmet.helmetCode)).toBeVisible();

    // Password + confirmation → atomic activation.
    await owner.fill('#reg-new', PASSWORD);
    await owner.fill('#reg-confirm', PASSWORD);
    await owner.getByRole('button', { name: 'Activate helmet' }).click();

    // Recovery code shown once; must be acknowledged before continuing.
    await expect(
      owner.getByText('Save this recovery code. It can be used if you forget your password.'),
    ).toBeVisible();
    recoveryCode = (await owner.getByTestId('recovery-code').innerText()).trim();
    expect(recoveryCode).toMatch(RECOVERY_CODE);
    const cont = owner.getByRole('button', { name: 'Continue' });
    await expect(cont).toBeDisabled();
    await owner.getByTestId('recovery-saved').check();
    await cont.click();
    await expect(owner.getByText(`${helmet.helmetCode} is yours.`)).toBeVisible();
    await expect(owner.getByTestId('recovery-code')).toHaveCount(0);

    // The scan page now reports a registered helmet without a shared profile.
    const scan = await anonymousMobilePage(browser);
    await scan.goto(helmet.qrUrl);
    await expect(scan.getByText(/has not shared emergency information/)).toBeVisible();
    await scan.context().close();
  });

  test('customer completes onboarding and enables the emergency profile', async () => {
    await owner.getByRole('button', { name: 'Set up emergency profile' }).click();
    await owner.fill('#p-name', OWNER);
    await owner.selectOption('#p-blood', 'O_POSITIVE');
    await owner.fill('#p-allergies', 'Penicillin');
    await owner.fill('#p-meds', 'Salbutamol');
    await owner.fill('#p-notes', 'Inhaler in left jacket pocket');
    await owner.getByRole('button', { name: 'Save and continue' }).click();

    await expect(owner.getByRole('heading', { name: 'Emergency contacts' })).toBeVisible();
    await owner.getByRole('button', { name: 'Add emergency contact' }).click();
    await owner.fill('#c-name-new', 'Ravi Verma');
    await owner.fill('#c-rel-new', 'Brother');
    await owner.fill('#c-phone-new', '98123 45678');
    await owner.getByRole('button', { name: 'Add contact' }).click();
    await expect(owner.getByText('Ravi Verma')).toBeVisible();
    await owner.getByRole('button', { name: 'Continue' }).click();

    await expect(owner.getByRole('heading', { name: 'Choose public information' })).toBeVisible();
    for (const key of ['showName', 'showBloodGroup', 'showAllergies', 'showEmergencyContacts'])
      await owner.getByTestId(`vis-${key}`).check({ force: true });
    await owner.getByRole('button', { name: 'Save and continue' }).click();

    await expect(owner.getByTestId('public-preview')).toContainText(OWNER);
    await expect(owner.getByTestId('public-preview')).not.toContainText('Salbutamol');
    await owner.getByRole('button', { name: 'Looks good' }).click();
    await owner.getByRole('button', { name: 'Turn on emergency profile' }).click();
    await expect(
      owner.getByRole('heading', { name: 'Your helmet emergency profile is active.' }),
    ).toBeVisible();

    await owner.getByRole('link', { name: 'Go to dashboard' }).click();
    await expect(owner.getByTestId('helmet-card')).toContainText('Profile active');
  });

  test('owner signs out and signs back in with Helmet ID + password', async () => {
    await owner.goto(portal('/app/account'));
    await owner.getByRole('button', { name: 'Sign out', exact: true }).click();
    await owner.goto(portal('/app'));
    await expect(owner.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await signIn(owner, PASSWORD);
    await expect(owner.getByTestId('helmet-card')).toContainText(helmet.helmetCode);
    await expect(owner.getByTestId('helmet-card')).toContainText('Profile active');
  });

  test('anonymous scan shows only the approved information', async ({ browser }) => {
    const scan = await anonymousMobilePage(browser);
    await scan.goto(helmet.qrUrl);
    await expect(scan.getByRole('heading', { name: 'Emergency profile' })).toBeVisible();
    await expect(scan.getByText(OWNER)).toBeVisible();
    await expect(scan.getByText('O+', { exact: true })).toBeVisible();
    await expect(scan.getByText('Penicillin')).toBeVisible();
    await expect(scan.getByText('Ravi Verma')).toBeVisible();
    await expect(scan.getByRole('link', { name: 'Call Ravi' })).toHaveAttribute(
      'href',
      'tel:+919812345678',
    );
    await expect(scan.getByRole('heading', { name: 'Emergency Contact' })).toBeVisible();
    await expect(
      scan.getByText(
        'Emergency information and contacts were provided by the helmet owner and are not verified.',
      ),
    ).toBeVisible();
    const body = await scan.locator('body').innerText();
    expect(body).not.toContain('Salbutamol');
    expect(body).not.toContain('Inhaler');
    expect(body).not.toContain(helmet.pin);
    await scan.context().close();
  });

  test('owner hides a field and the public page updates', async ({ browser }) => {
    await owner.goto(portal('/app/privacy'));
    await owner.getByTestId('vis-showAllergies').uncheck({ force: true });
    await owner.getByRole('button', { name: 'Save privacy choices' }).click();
    await expect(owner.getByTestId('public-preview')).not.toContainText('Penicillin');

    const scan = await anonymousMobilePage(browser);
    await scan.goto(helmet.qrUrl);
    await expect(scan.getByText(OWNER)).toBeVisible();
    await expect(scan.getByText('Penicillin')).toHaveCount(0);
    await scan.context().close();
  });

  test('forgotten password: recover with Helmet ID + recovery code', async ({ browser }) => {
    const device = await anonymousMobilePage(browser);
    await device.goto(portal('/login'));
    await device.getByRole('link', { name: 'Forgot password?' }).click();
    await device.fill('#rec-helmet', helmet.helmetCode);
    await device.fill('#rec-code', recoveryCode.toLowerCase().replaceAll('-', ' '));
    await device.getByRole('button', { name: 'Continue' }).click();

    await device.fill('#reset-new', NEW_PASSWORD);
    await device.fill('#reset-confirm', NEW_PASSWORD);
    await device.getByRole('button', { name: 'Set new password' }).click();

    // A new recovery code replaces the old one, shown once.
    await expect(device.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    const newCode = (await device.getByTestId('recovery-code').innerText()).trim();
    expect(newCode).toMatch(RECOVERY_CODE);
    expect(newCode).not.toBe(recoveryCode);
    await device.getByTestId('recovery-saved').check();
    await device.getByRole('button', { name: 'Go to my account' }).click();
    await expect(device.getByTestId('helmet-card')).toContainText(helmet.helmetCode);
    await device.context().close();

    // The reset signed out every other session, including the owner's page.
    await owner.goto(portal('/app'));
    await expect(owner.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('old password fails, new password works, old recovery code is dead', async ({ browser }) => {
    await signIn(owner, PASSWORD);
    await expect(owner.getByText('The Helmet ID or password is incorrect.')).toBeVisible();

    await signIn(owner, NEW_PASSWORD);
    await expect(owner.getByTestId('helmet-card')).toContainText(helmet.helmetCode);

    const device = await anonymousMobilePage(browser);
    await device.goto(portal('/recover'));
    await device.fill('#rec-helmet', helmet.helmetCode);
    await device.fill('#rec-code', recoveryCode);
    await device.getByRole('button', { name: 'Continue' }).click();
    await expect(device.getByText('The Helmet ID or recovery code is incorrect.')).toBeVisible();
    await device.context().close();
  });

  test('owner disables the profile and public information disappears', async ({ browser }) => {
    await owner.goto(portal('/app/privacy'));
    await owner.getByRole('button', { name: 'Turn off emergency profile' }).click();
    await expect(owner.getByRole('button', { name: 'Turn on emergency profile' })).toBeVisible();

    const scan = await anonymousMobilePage(browser);
    await scan.goto(helmet.qrUrl);
    await expect(scan.getByText(/has not shared emergency information/)).toBeVisible();
    const body = await scan.locator('body').innerText();
    expect(body).not.toContain(OWNER);
    expect(body).not.toContain('Ravi Verma');
    await scan.context().close();
    await owner.context().close();
  });
});
