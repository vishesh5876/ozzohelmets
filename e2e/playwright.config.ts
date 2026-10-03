import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against locally started apps (`pnpm dev`, with PostgreSQL + Redis up and OTP_PROVIDER=development).
 * Set E2E_START_SERVERS=1 to let Playwright start them. URLs are overridable for other environments.
 */
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3000';
const PORTAL_URL = process.env.E2E_PORTAL_URL ?? 'http://localhost:3001';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Use the pre-installed Chromium when PLAYWRIGHT_CHROMIUM_PATH is set (CI images, sandboxes).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  metadata: { ADMIN_URL, PORTAL_URL, API_URL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_START_SERVERS
    ? [
        { command: 'pnpm --filter @helmet/api dev', url: `${API_URL}/api/v1/health`, reuseExistingServer: true, timeout: 120_000, cwd: '..' },
        { command: 'pnpm --filter @helmet/admin dev', url: ADMIN_URL, reuseExistingServer: true, timeout: 120_000, cwd: '..' },
        { command: 'pnpm --filter @helmet/portal dev', url: PORTAL_URL, reuseExistingServer: true, timeout: 120_000, cwd: '..' },
      ]
    : undefined,
});
