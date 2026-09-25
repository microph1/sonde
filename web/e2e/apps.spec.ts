import { expect, test } from '@playwright/test';

test.describe('apps and keys', () => {
  test('creates an app, issues a key once, and revokes it', async ({ page }) => {
    const name = `e2e-app-${Date.now().toString(36)}`;

    await page.goto('/apps');

    await page.getByPlaceholder('microgamma').fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('table').first()).toContainText(name);

    await page.locator('select').first().selectOption({ label: name });
    await page.getByPlaceholder('relay').fill('e2e-key');
    await page.getByRole('button', { name: 'Issue key' }).click();

    // The secret is shown exactly once, because it is stored only as a hash.
    const secret = page.locator('.secret');
    await expect(secret).toBeVisible();
    await expect(secret).toHaveText(/^wk_/);
    const issued = (await secret.textContent())?.trim() ?? '';

    await page.getByRole('button', { name: 'I have copied it' }).click();
    await expect(secret).toBeHidden();

    // Nowhere in the list, and nowhere in the API's own answer either.
    await expect(page.locator('body')).not.toContainText(issued);

    await page
      .locator('tr', { hasText: 'e2e-key' })
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(page.locator('tr', { hasText: 'e2e-key' })).toContainText('revoked');
  });

  test('a public key demands the origins that make it safe', async ({ page }) => {
    await page.goto('/apps');

    await page.locator('select').nth(1).selectOption('public');

    await expect(page.locator('#origins-help')).toContainText('readable by anyone');
  });
});
