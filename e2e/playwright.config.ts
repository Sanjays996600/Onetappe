import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests of the whole system: API + background worker + admin panel and the web
 * builds of the customer and worker apps, against a fresh PostgreSQL database.
 * `E2E_CHROMIUM_PATH` points at a preinstalled Chromium when the Playwright download is
 * not available (sandboxes); CI installs the matching browser.
 */
const executablePath = process.env['E2E_CHROMIUM_PATH'];

export default defineConfig({
  testDir: './tests',
  globalSetup: './harness/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
