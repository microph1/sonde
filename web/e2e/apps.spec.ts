import { expect, test } from '@playwright/test';

test.describe('apps and keys', () => {
  test('creates an app, issues a key once, and revokes it', async ({ page }) => {
    const name = `e2e-app-${Date.now().toString(36)}`;

    await page.goto('/apps');

    await page.getByPlaceholder('microgamma').fill(name);
    await page.getByRole('button', { name: 'Create app' }).click();

    await page.getByRole('link', { name }).click();
    await expect(page.locator('mat-card-title')).toHaveText(name);

    await page.getByRole('button', { name: 'Issue a key' }).click();
    await page.getByPlaceholder('relay').fill('e2e-key');
    await page.getByRole('button', { name: 'Issue key' }).click();

    // The secret is shown exactly once, because it is stored only as a hash.
    const secret = page.locator('.secret code');
    await expect(secret).toBeVisible();
    await expect(secret).toHaveText(/^wk_/);
    const issued = (await secret.textContent())?.trim() ?? '';

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(secret).toBeHidden();

    // Nowhere on the page, and nowhere in the API's own answer either.
    await expect(page.locator('body')).not.toContainText(issued);

    const key = page.locator('.key', { hasText: 'e2e-key' });

    await key.getByRole('button', { name: 'Revoke this key' }).click();
    await key.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(key).toContainText('revoked');

    // And clean up after itself: every app left behind shows up in the picker
    // of every later run.
    await page.getByRole('button', { name: 'Delete this app' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('link', { name })).toBeHidden();
  });

  test('a public key says what makes it safe', async ({ page }) => {
    const name = `e2e-public-${Date.now().toString(36)}`;

    await page.goto('/apps');
    await page.getByPlaceholder('microgamma').fill(name);
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.getByRole('link', { name }).click();

    await page.getByRole('button', { name: 'Issue a key' }).click();
    await page.getByRole('radio', { name: /public/ }).click();

    // A public key ships to browsers, so the field that bounds it appears with
    // the warning that explains why it is there.
    await expect(page.getByLabel('Allowed origins')).toBeVisible();
    await expect(page.locator('mat-hint')).toContainText('anyone who opens devtools');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Delete this app' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
  });

  test('the picker puts the chosen app in the path', async ({ page }) => {
    const name = `e2e-scope-${Date.now().toString(36)}`;

    await page.goto('/apps');
    await page.getByPlaceholder('microgamma').fill(name);
    await page.getByRole('button', { name: 'Create app' }).click();
    await page.getByRole('link', { name }).click();

    // The app is which data the console is of, not a filter over a shared view,
    // so it lives in the path and every section keeps it.
    await page.goto('/all/traces');
    await page.getByRole('button', { name: 'All apps' }).click();
    await page.getByRole('menuitem', { name }).click();

    await expect(page).toHaveURL(/^http:\/\/[^/]+\/[0-9a-f-]{36}\/traces/);
    await expect(page.getByRole('button', { name })).toBeVisible();

    // Nothing was ever ingested under it, so the view is honestly empty rather
    // than showing another app's traces.
    await expect(page.locator('.status')).toContainText('0 traces');

    await page.goto('/apps');
    await page.getByRole('link', { name }).click();
    await page.getByRole('button', { name: 'Delete this app' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
  });
});
