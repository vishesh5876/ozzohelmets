import { readFileSync } from 'node:fs';
import { type Browser, devices, expect, type Page, test } from '@playwright/test';

/**
 * The whole product with no retail or inventory step: Admin manufactures → the helmet ships
 * with its QR + one-time PIN → the buyer scans, proves possession with the PIN, binds an email +
 * password → emergency profile → second helmet → warranty → public pages → recovery → email
 * change. Helmets are activated straight from PRINTED.
 */
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe-Dev-Only-123!';

const run = Date.now().toString(36).toUpperCase();
const SKU = `CJ-${run}`;
const OWNER = 'Kavya Rao';
const EMAIL = `Kavya.${run.toLowerCase()}@Example.com`;
const NEW_EMAIL = `kavya.new.${run.toLowerCase()}@example.com`;
const PASSWORD = 'monsoon roads at noon';
const NEW_PASSWORD = 'evening ride by the sea';
const SELLER = 'Corner Helmet Shop';
const RECOVERY_CODE = /^RK-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/;
// The UI-created batch is manufactured today, so the purchase is today too.
const purchaseDate = new Date().toISOString().slice(0, 10);

interface Helmet {
  helmetCode: string;
  qrUrl: string;
  pin: string;
}

async function mobile(browser: Browser): Promise<Page> {
  return (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
}

test.describe.serial('Customer journey: QR + PIN → email account → profile → recovery', () => {
  let first: Helmet;
  let second: Helmet;
  let owner: Page;
  let recoveryCode: string;
  const portal = (path: string) => new URL(path, first.qrUrl).toString();

  async function signIn(page: Page, identifier: string, password: string) {
    await page.goto(portal('/login'));
    await page.fill('#login-identifier', identifier);
    await page.fill('#login-password', password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  test('1–2: admin generates helmets; the manufacturing export carries each one-time PIN', async ({
    page,
  }) => {
    await page.goto(`${ADMIN_URL}/login`);
    await page.fill('#email', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASSWORD);
    await page.click('button[type=submit]');
    await expect(page.getByText('Helmets by status')).toBeVisible();

    await page.goto(`${ADMIN_URL}/models`);
    await page.getByRole('button', { name: 'New model' }).first().click();
    await page.fill('#m-name', `Journey ${run}`);
    await page.fill('#m-sku', SKU);
    await page.fill('#m-brand', 'Ozzo');
    await page.click('dialog button[type=submit]');
    await expect(page.getByRole('cell', { name: SKU })).toBeVisible();

    await page.goto(`${ADMIN_URL}/batches/new`);
    await page.locator('#b-model option', { hasText: SKU }).waitFor({ state: 'attached' });
    await page.selectOption('#b-model', { label: `Journey ${run} — ${SKU}` });
    await page.fill('#b-qty', '2');
    await page.click('button[type=submit]');
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible({ timeout: 60_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    const rows = readFileSync((await download.path())!, 'utf8')
      .trim()
      .split('\r\n')
      .slice(1)
      .map((line) => {
        const [helmetCode, , , , qrUrl, pin] = line.split(',');
        return { helmetCode: helmetCode!, qrUrl: qrUrl!, pin: pin! };
      });
    [first, second] = rows as [Helmet, Helmet];
    for (const h of rows) expect(h.pin).toMatch(/^[23456789A-HJ-NP-Z]{8}$/);

    // Labels printed (escrow purged). No inventory or sale step follows.
    await page.getByRole('button', { name: 'Mark printed' }).click();
    await page.getByRole('button', { name: 'Confirm printed' }).click();
    await expect(page.getByText('Printed', { exact: true }).first()).toBeVisible();
  });

  test('3–4: scanning the QR shows the helmet is ready to activate', async ({ browser }) => {
    owner = await mobile(browser);
    await owner.goto(first.qrUrl);
    await expect(owner.getByRole('heading', { name: 'Helmet not activated' })).toBeVisible();
    await expect(owner.getByText(/Ready to activate/)).toBeVisible();
  });

  test('5–9: PIN → email → password → account created → recovery code shown once', async () => {
    await owner.getByRole('link', { name: 'Activate helmet' }).click();
    await owner.fill('#pin', first.pin);
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(owner.getByText(/PIN accepted/)).toBeVisible();

    await owner.fill('#reg-email', EMAIL);
    await expect(
      owner.getByText('Make sure this email is correct. You will use it to sign in.'),
    ).toBeVisible();
    await owner.fill('#reg-name', OWNER);
    await owner.fill('#reg-new', PASSWORD);
    await owner.fill('#reg-confirm', PASSWORD);
    await owner.getByRole('button', { name: 'Activate helmet' }).click();

    await expect(
      owner.getByText('Save this recovery code. It can be used if you forget your password.'),
    ).toBeVisible();
    recoveryCode = (await owner.getByTestId('recovery-code').innerText()).trim();
    expect(recoveryCode).toMatch(RECOVERY_CODE);
    await owner.getByTestId('recovery-saved').check();
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(owner.getByText(`${first.helmetCode} is yours.`)).toBeVisible();
    await expect(owner.getByTestId('recovery-code')).toHaveCount(0);
  });

  test('10–13: emergency profile, contact, privacy, enable', async () => {
    await owner.getByRole('button', { name: 'Set up emergency profile' }).click();
    await owner.fill('#p-name', OWNER);
    await owner.selectOption('#p-blood', 'B_POSITIVE');
    await owner.fill('#p-allergies', 'Peanuts');
    await owner.fill('#p-meds', 'Metformin');
    await owner.getByRole('button', { name: 'Save and continue' }).click();

    await expect(owner.getByRole('heading', { name: 'Emergency contacts' })).toBeVisible();
    await owner.getByRole('button', { name: 'Add emergency contact' }).click();
    await owner.fill('#c-name-new', 'Arjun Rao');
    await owner.fill('#c-rel-new', 'Husband');
    await owner.fill('#c-phone-new', '98450 12345');
    await owner.getByRole('button', { name: 'Add contact' }).click();
    await expect(owner.getByText('Arjun Rao')).toBeVisible();
    await owner.getByRole('button', { name: 'Continue' }).click();

    await expect(owner.getByRole('heading', { name: 'Choose public information' })).toBeVisible();
    for (const key of ['showName', 'showBloodGroup', 'showAllergies', 'showEmergencyContacts'])
      await owner.getByTestId(`vis-${key}`).check({ force: true });
    await owner.getByRole('button', { name: 'Save and continue' }).click();
    await owner.getByRole('button', { name: 'Looks good' }).click();
    await owner.getByRole('button', { name: 'Turn on emergency profile' }).click();
    await expect(
      owner.getByRole('heading', { name: 'Your helmet emergency profile is active.' }),
    ).toBeVisible();
  });

  test('14–16: sign out, sign back in with email + password, profile is there', async () => {
    await owner.goto(portal('/app/account'));
    await expect(owner.getByTestId('account-email')).toHaveText(
      EMAIL.replace(/@.*/, '@example.com'),
    );
    await expect(owner.getByText(/verified email/i)).toHaveCount(0);
    await owner.getByRole('button', { name: 'Sign out', exact: true }).click();
    await owner.goto(portal('/app'));
    await expect(owner.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await signIn(owner, EMAIL.toLowerCase(), PASSWORD);
    await expect(owner.getByTestId('helmet-card')).toContainText(first.helmetCode);
    await owner.goto(portal('/app/profile'));
    await expect(owner.locator('#p-name')).toHaveValue(OWNER);
  });

  test('17–18: a second helmet joins the same account with only its PIN', async () => {
    await owner.goto(second.qrUrl);
    await owner.getByRole('link', { name: 'Activate helmet' }).click();
    await owner.fill('#pin', second.pin);
    await owner.getByRole('button', { name: 'Add helmet to my account' }).click();
    await expect(owner.getByText(`${second.helmetCode} is yours.`)).toBeVisible();
    await owner.goto(portal('/app/helmets'));
    await expect(owner.getByTestId('helmet-card')).toHaveCount(2);
    for (const h of [first, second])
      await expect(
        owner.getByTestId('helmet-card').filter({ hasText: h.helmetCode }),
      ).toBeVisible();
  });

  test('19: customer registers the warranty with a free-text seller', async () => {
    await owner.getByRole('link', { name: 'Warranty', exact: true }).click();
    await owner
      .getByRole('listitem')
      .filter({ hasText: first.helmetCode })
      .getByRole('link', { name: 'Register warranty' })
      .click();
    await owner.fill('#w-date', purchaseDate);
    await owner.selectOption('#w-channel', 'RETAIL_STORE');
    await owner.fill('#w-seller', SELLER);
    await owner.getByRole('button', { name: 'Review' }).click();
    await owner.getByRole('button', { name: 'Register warranty' }).click();
    await expect(owner.getByTestId('warranty-card')).toContainText('Warranty active');
  });

  test('20–21: public authenticity and public emergency pages show only approved information', async ({
    browser,
  }) => {
    const verify = await mobile(browser);
    await verify.goto(first.qrUrl.replace('/e/', '/verify/'));
    await expect(verify.locator('main')).not.toContainText('Checking…');
    const v = await verify.locator('body').innerText();
    expect(v).toContain('Product identity verified');
    expect(v).toContain(first.helmetCode);
    for (const leak of [OWNER, SELLER, EMAIL, first.pin]) expect(v).not.toContain(leak);
    expect(v).not.toMatch(/retailer|distributor|dealer|supply chain/i);
    await verify.context().close();

    const scan = await mobile(browser);
    await scan.goto(first.qrUrl);
    await expect(scan.getByRole('heading', { name: 'Emergency profile' })).toBeVisible();
    await expect(scan.getByText(OWNER)).toBeVisible();
    await expect(scan.getByText('Peanuts')).toBeVisible();
    await expect(scan.getByText('Arjun Rao')).toBeVisible();
    const e = await scan.locator('body').innerText();
    for (const leak of ['Metformin', EMAIL, EMAIL.toLowerCase(), first.pin])
      expect(e).not.toContain(leak);
    await scan.context().close();
  });

  test('22: forgotten password — email + recovery code, no mailbox access needed', async ({
    browser,
  }) => {
    const device = await mobile(browser);
    await device.goto(portal('/recover'));
    await device.fill('#rec-identifier', EMAIL);
    await device.fill('#rec-code', recoveryCode);
    await device.getByRole('button', { name: 'Continue' }).click();
    await device.fill('#reset-new', NEW_PASSWORD);
    await device.fill('#reset-confirm', NEW_PASSWORD);
    await device.getByRole('button', { name: 'Set new password' }).click();
    await expect(device.getByRole('heading', { name: 'Password changed' })).toBeVisible();
    const rotated = (await device.getByTestId('recovery-code').innerText()).trim();
    expect(rotated).toMatch(RECOVERY_CODE);
    expect(rotated).not.toBe(recoveryCode);
    await device.getByTestId('recovery-saved').check();
    await device.getByRole('button', { name: 'Go to my account' }).click();
    await expect(device.getByTestId('helmet-card')).toHaveCount(2);
    await device.context().close();

    // The reset revoked every other session.
    await owner.goto(portal('/app'));
    await expect(owner.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('23: change the account email (password + confirmation, warning shown)', async () => {
    await signIn(owner, EMAIL, NEW_PASSWORD);
    await expect(owner.getByTestId('helmet-card').first()).toBeVisible();
    await owner.goto(portal('/app/account'));
    await owner.getByRole('button', { name: 'Change email' }).click();
    await owner.fill('#ce-email', NEW_EMAIL);
    await owner.fill('#ce-confirm', NEW_EMAIL);
    await owner.fill('#ce-password', NEW_PASSWORD);
    await owner.getByRole('button', { name: 'Continue' }).click();
    await expect(owner.getByTestId('confirm-new-email')).toHaveText(NEW_EMAIL);
    await expect(
      owner.getByText('Make sure this email is correct. You will use it to sign in.'),
    ).toBeVisible();
    await owner.getByRole('button', { name: 'Confirm email change' }).click();
    await expect(owner.getByTestId('account-email')).toHaveText(NEW_EMAIL);
    await expect(
      owner.getByText('Email updated. Your other devices were signed out.'),
    ).toBeVisible();
    await owner.getByRole('button', { name: 'Sign out', exact: true }).click();
  });

  test('24–25: the old email no longer signs in; the new one does', async () => {
    await signIn(owner, EMAIL, NEW_PASSWORD);
    await expect(owner.getByText('The email, ID or password is incorrect.')).toBeVisible();
    await signIn(owner, NEW_EMAIL, NEW_PASSWORD);
    await expect(owner.getByTestId('helmet-card')).toHaveCount(2);
    await owner.context().close();
  });
});
