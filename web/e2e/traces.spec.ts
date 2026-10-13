import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

const API = process.env['SONDE_E2E_API'] ?? 'http://localhost:4319';

test.describe('traces', () => {
  test('opens a trace in place and draws its waterfall', async ({ page, request }) => {
    const service = uniqueService('trace');
    await seedTrace(request, service, { name: 'GET /waterfall' });

    await page.goto(`/all/traces?service=${service}`);

    // One row per trace, not per span: the two spans are what the row opens to.
    await expect(page.locator('.status')).toContainText('1 traces');

    await page.getByRole('button', { name: /GET \/waterfall/ }).click();

    // Still on the list. Reading a trace is a step in scanning many, so the
    // search, the scroll position and the other rows survive it.
    await expect(page).toHaveURL(new RegExp(`/all/traces\\?service=${service}$`));

    await expect(page.locator('.waterfall li')).toHaveCount(2);
    await expect(page.locator('.waterfall li').first()).toContainText('GET /waterfall');
    await expect(page.locator('.waterfall li').nth(1)).toContainText('db.query');
  });

  test('a trace shows the log records emitted inside it', async ({ page, request }) => {
    const service = uniqueService('correlated');
    await seedTrace(request, service, { name: 'GET /correlated' });

    await page.goto(`/all/traces?service=${service}`);
    await page.getByRole('button', { name: /GET \/correlated/ }).click();

    await expect(page.locator('.logs-head')).toContainText('1 log record');
    await expect(page.locator('.logs .line')).toContainText(`e2e log for ${service}`);
  });

  test('two traces can be open at once', async ({ page, request }) => {
    const service = uniqueService('compare');
    await seedTrace(request, service, { name: 'GET /first' });
    await seedTrace(request, service, { name: 'GET /second' });

    await page.goto(`/all/traces?service=${service}`);

    // Comparing two traces means having both open; an accordion that closed one
    // to show the other would make that impossible.
    await page.getByRole('button', { name: /GET \/first/ }).click();
    await page.getByRole('button', { name: /GET \/second/ }).click();

    await expect(page.locator('.waterfall')).toHaveCount(2);
  });

  test('a link to a trace opens that trace', async ({ page, request }) => {
    const service = uniqueService('linked');
    const { traceId } = await seedTrace(request, service, { name: 'GET /linked' });

    // A panel you cannot link to is a worse page, not a better one.
    await page.goto(`/all/traces/${traceId}?service=${service}`);

    await expect(page.locator('.trace-id code')).toHaveText(traceId);
    await expect(page.locator('.waterfall li')).toHaveCount(2);
  });

  test('an errored trace is marked as such', async ({ page, request }) => {
    const service = uniqueService('failing');
    await seedTrace(request, service, { status: 2 });

    await page.goto(`/all/traces?service=${service}&status=Error`);

    await expect(page.locator('.chip.status-Error').first()).toHaveText('1 error');
  });

  test('the live tail announces itself before any row arrives', async ({ page }) => {
    // The interesting case: a quiet tail must still say it is live, because a
    // reducer only runs when its effect emits.
    await page.goto(`/all/traces?service=${uniqueService('silent')}`);
    await page.getByRole('button', { name: 'Live tail' }).click();

    await expect(page.locator('.pill')).toHaveText('live');
    await expect(page.getByRole('button', { name: 'Stop tail' })).toBeVisible();
    await expect(page.locator('.status')).toContainText('0 traces');
  });

  test('a live tail picks up a span sent while it is open', async ({ page, request }) => {
    const service = uniqueService('tailing');

    await page.goto(`/all/traces?service=${service}`);
    await page.getByRole('button', { name: 'Live tail' }).click();
    await expect(page.locator('.pill')).toHaveText('live');

    await seedTrace(request, service, { name: 'arrived-live' });

    await expect(page.locator('mat-accordion')).toContainText('arrived-live', {
      timeout: 30_000,
    });
  });

  test('a malformed trace id is refused rather than queried', async ({ page, request }) => {
    const refusal = await request.get(`${API}/api/traces/not-a-trace-id`);

    expect(refusal.status()).toBe(400);
    expect((await refusal.json()).error).toContain('32 hex');

    // And the console survives being linked to one: no row matches it, so the
    // list is simply a list with nothing open.
    await page.goto('/all/traces/not-a-trace-id');

    await expect(page.locator('.status')).toBeVisible();
    await expect(page.locator('.waterfall')).toHaveCount(0);
  });
});
