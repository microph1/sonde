import { expect, test } from '@playwright/test';

/** Runs without the stored session, so it proves the guard rather than assuming
 * it. */
test('an anonymous visitor is sent to the identity provider', async ({ page }) => {
  await page.goto('/services');

  await page.waitForURL(/\/dex\/auth/, { timeout: 20_000 });
  await expect(page.locator('input[name=password]')).toBeVisible();
});

test('the read API refuses an unauthenticated request', async ({ request }) => {
  const response = await request.get(
    `${process.env['SONDE_E2E_API'] ?? 'http://localhost:4319'}/api/services`,
  );

  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ login: '/api/auth/login' });
});
