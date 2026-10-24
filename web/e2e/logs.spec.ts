import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

test.describe('logs', () => {
  test('shows the shape of the search above the lines it matched', async ({ page, request }) => {
    const service = uniqueService('shape');

    await seedTrace(request, service, { status: 2 });

    await page.goto(`/all/logs?service=${service}&range=1h`);

    const strip = page.locator('.shape');

    // The seeded record is an error, so that is the band the chart draws and
    // the legend names. A list of lines cannot say when they happened.
    await expect(strip).toBeVisible();
    await expect(strip.locator('.legend')).toContainText('error');
  });

  test('the shape follows the filters, not only the window', async ({ page, request }) => {
    const service = uniqueService('shape-filter');

    await seedTrace(request, service);

    // Seeded at INFO, so asking for errors alone has to empty the chart as well
    // as the table: a chart of a different set than the table under it is worse
    // than no chart.
    await page.goto(`/all/logs?service=${service}&minSeverity=17&range=1h`);

    await expect(page.locator('.shape')).toContainText('Nothing matched in this window.');
  });

  test('searches and links back to the trace it came from', async ({ page, request }) => {
    const service = uniqueService('logs');
    const { traceId } = await seedTrace(request, service);

    await page.goto(`/all/logs?service=${service}`);

    await expect(page.locator('tbody')).toContainText(`e2e log for ${service}`);
    await expect(page.getByRole('link', { name: new RegExp(traceId.slice(0, 12)) })).toBeVisible();
  });

  test('severity filtering keeps only what was asked for', async ({ page, request }) => {
    const errored = uniqueService('logs-error');
    await seedTrace(request, errored, { status: 2 });

    await page.goto(`/all/logs?service=${errored}&minSeverity=17`);

    await expect(page.locator('tbody .sev-error').first()).toHaveText('ERROR');
  });

  test('a live tail picks up a record sent while it is open', async ({ page, request }) => {
    const service = uniqueService('logs-tail');

    await page.goto(`/all/logs?service=${service}`);
    await page.getByRole('button', { name: 'Live tail' }).click();
    await expect(page.locator('.pill')).toHaveText('live');

    await seedTrace(request, service);

    await expect(page.locator('tbody')).toContainText(`e2e log for ${service}`, {
      timeout: 30_000,
    });
  });
});
