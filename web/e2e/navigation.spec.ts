import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

const API = process.env['SONDE_E2E_API'] ?? 'http://localhost:4319';

const SECTIONS = ['Services', 'Traces', 'Map', 'Logs', 'Metrics'] as const;

/**
 * The app is in the path, so every link has to carry it.
 *
 * This is the spec that exists because of how the scoping broke: an absolute
 * `['/traces']` does not merely lose the app, it matches `:appId` and lands on
 * `/traces/services`, looking for an app named "traces". One dead link at a
 * time is how that gets found otherwise.
 */
test.describe('navigation', () => {
  test('every section keeps the scope, under all apps and under one', async ({ page, request }) => {
    const created = await request.post(`${API}/api/apps`, {
      data: { name: `e2e-nav-${Date.now().toString(36)}` },
    });
    expect(created.ok(), 'the app should be created').toBeTruthy();
    const app = (await created.json()) as { id: string; name: string };

    for (const appId of ['all', app.id]) {
      await page.goto(`/${appId}/services`);

      for (const section of SECTIONS) {
        await page.getByRole('tab', { name: section }).click();

        await expect(page).toHaveURL(new RegExp(`/${appId}/${section.toLowerCase()}\\b`));
      }
    }

    await request.delete(`${API}/api/apps/${app.id}`);
  });

  test('a log record links to its trace in the same app', async ({ page, request }) => {
    const service = uniqueService('crosslink');
    const { traceId } = await seedTrace(request, service);

    await page.goto(`/all/logs?service=${service}`);
    await page.getByRole('link', { name: new RegExp(traceId.slice(0, 12)) }).click();

    await expect(page).toHaveURL(`/all/traces/${traceId}`);
    await expect(page.locator('.trace-id code')).toHaveText(traceId);
  });

  test('managing apps is outside the scope, and coming back keeps it', async ({ page }) => {
    await page.goto('/all/logs');

    await page.getByRole('button', { name: 'All apps' }).click();
    await page.getByRole('menuitem', { name: 'Manage apps & keys' }).click();

    // Managing apps is not looking at one, so that page has no scope at all.
    await expect(page).toHaveURL('/apps');
    await expect(page.getByRole('button', { name: 'All apps' })).toBeVisible();

    await page.getByRole('tab', { name: 'Logs' }).click();
    await expect(page).toHaveURL(/\/all\/logs/);
  });
});
