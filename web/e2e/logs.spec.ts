import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

test.describe('logs', () => {
  test('searches and links back to the trace it came from', async ({ page, request }) => {
    const service = uniqueService('logs');
    const { traceId } = await seedTrace(request, service);

    await page.goto(`/logs?service=${service}`);

    await expect(page.locator('tbody')).toContainText(`e2e log for ${service}`);
    await expect(page.getByRole('link', { name: new RegExp(traceId.slice(0, 12)) })).toBeVisible();
  });

  test('severity filtering keeps only what was asked for', async ({ page, request }) => {
    const errored = uniqueService('logs-error');
    await seedTrace(request, errored, { status: 2 });

    await page.goto(`/logs?service=${errored}&minSeverity=17`);

    await expect(page.locator('tbody .sev-error').first()).toHaveText('ERROR');
  });

  test('a live tail picks up a record sent while it is open', async ({ page, request }) => {
    const service = uniqueService('logs-tail');

    await page.goto(`/logs?service=${service}`);
    await page.getByRole('button', { name: 'Live tail' }).click();
    await expect(page.locator('.pill')).toHaveText('live');

    await seedTrace(request, service);

    await expect(page.locator('tbody')).toContainText(`e2e log for ${service}`, {
      timeout: 30_000,
    });
  });
});
