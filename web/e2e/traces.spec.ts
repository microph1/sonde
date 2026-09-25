import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

test.describe('traces', () => {
  test('searches, opens a trace, and draws its waterfall', async ({ page, request }) => {
    const service = uniqueService('trace');
    const { traceId } = await seedTrace(request, service, { name: 'GET /waterfall' });

    await page.goto(`/traces?service=${service}`);

    await expect(page.locator('.status')).toContainText('2 spans');
    await page.getByRole('link', { name: new RegExp(traceId.slice(0, 12)) }).click();

    await expect(page).toHaveURL(new RegExp(traceId));
    // Parent and child, the child indented under it.
    await expect(page.locator('.waterfall li')).toHaveCount(2);
    await expect(page.locator('.waterfall li').first()).toContainText('GET /waterfall');
    await expect(page.locator('.waterfall li').nth(1)).toContainText('db.query');
  });

  test('an errored span is marked as such', async ({ page, request }) => {
    const service = uniqueService('failing');
    await seedTrace(request, service, { status: 2 });

    await page.goto(`/traces?service=${service}&status=Error`);

    await expect(page.locator('tbody .status-Error').first()).toHaveText('Error');
  });

  test('the live tail announces itself before any row arrives', async ({ page }) => {
    // The interesting case: a quiet tail must still say it is live, because a
    // reducer only runs when its effect emits.
    await page.goto(`/traces?service=${uniqueService('silent')}`);
    await page.getByRole('button', { name: 'Live tail' }).click();

    await expect(page.locator('.pill')).toHaveText('live');
    await expect(page.getByRole('button', { name: 'Stop tail' })).toBeVisible();
    await expect(page.locator('.status')).toContainText('0 spans');
  });

  test('a live tail picks up a span sent while it is open', async ({ page, request }) => {
    const service = uniqueService('tailing');

    await page.goto(`/traces?service=${service}`);
    await page.getByRole('button', { name: 'Live tail' }).click();
    await expect(page.locator('.pill')).toHaveText('live');

    await seedTrace(request, service, { name: 'arrived-live' });

    await expect(page.locator('tbody')).toContainText('arrived-live', { timeout: 30_000 });
  });

  test('a malformed trace id is refused rather than queried', async ({ page }) => {
    await page.goto('/traces/not-a-trace-id');

    await expect(page.locator('.waterfall')).toContainText('No spans found');
  });
});
