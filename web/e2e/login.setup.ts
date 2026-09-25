import { expect, test as setup } from '@playwright/test';

const SESSION = 'e2e/.auth/session.json';

/**
 * Logs in once and saves the session for every other spec.
 *
 * Through the real identity provider rather than by forging a cookie: the login
 * flow is the part most likely to break silently, and a forged session would
 * prove the console renders while saying nothing about whether anyone can get
 * into it.
 */
setup('sign in', async ({ page }) => {
  const user = process.env['SONDE_E2E_USER'] ?? 'dcavaliere@local';
  const password = process.env['SONDE_E2E_PASSWORD'] ?? 'sonde';

  await page.goto('/services');

  // The guard bounces an anonymous visitor to the provider.
  await page.waitForURL(/\/dex\/auth/, { timeout: 20_000 });

  await page.fill('input[name=login]', user);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');

  await page.waitForURL(/\/services/, { timeout: 20_000 });
  await expect(page.locator('.account')).toContainText(user);

  await page.context().storageState({ path: SESSION });
});
