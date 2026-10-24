import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

/** Both ends of a window, as `datetime-local` wants them. */
function local(at: Date): string {
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

test.describe('time range', () => {
  test('an absolute window travels in the URL and can be reopened', async ({ page, request }) => {
    const service = uniqueService('window');

    await seedTrace(request, service);

    const now = new Date();
    const from = new Date(now.getTime() - 30 * 60_000);

    await page.goto(`/all/traces?service=${service}`);
    await page.getByRole('button', { name: /Custom/ }).click();
    await page.locator('input[formcontrolname=from]').fill(local(from));
    await page.locator('input[formcontrolname=to]').fill(local(now));
    await page.getByRole('button', { name: 'Apply' }).click();

    // The window is in the URL, which is the whole point: a view of a moment is
    // worth nothing if it cannot be sent to someone.
    await expect(page).toHaveURL(/[?&]from=/);
    await expect(page).toHaveURL(/[?&]to=/);
    await expect(page).not.toHaveURL(/[?&]range=/);

    // Seeded inside it, so it is still found.
    await expect(page.locator('.status')).toContainText('1 traces');

    // And opening the link again lands on the same window rather than a preset.
    const link = page.url();

    await page.goto('/all/services');
    await page.goto(link);
    await expect(page.getByRole('button', { name: /^(?!Custom).*–/ })).toBeVisible();
  });

  test('a window that excludes the data finds nothing, honestly', async ({ page, request }) => {
    const service = uniqueService('past');

    await seedTrace(request, service);

    // An hour that ended before anything was seeded. The console could not
    // express this at all until the window had two ends: everything was "the
    // last N", so a finished incident was unreachable.
    const to = new Date(Date.now() - 2 * 60 * 60_000);
    const from = new Date(to.getTime() - 60 * 60_000);

    await page.goto(
      `/all/traces?service=${service}&from=${from.toISOString()}&to=${to.toISOString()}`,
    );

    await expect(page.locator('.status')).toContainText('0 traces');
  });

  test('the presets still win when no window is named', async ({ page }) => {
    await page.goto('/all/services');

    // A link that names nothing gets the default written into it, so the URL
    // always says what is on screen.
    await expect(page).toHaveURL(/range=24h/);
  });
});
