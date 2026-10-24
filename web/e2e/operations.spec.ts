import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

test.describe('operations', () => {
  test('ranks a service by what each operation costs', async ({ page, request }) => {
    const service = uniqueService('ops');

    // Two spans of known, different durations: the root takes 25 ms and the
    // child 8 ms, so sorting by p95 has a right answer.
    await seedTrace(request, service, { name: 'GET /slow' });

    await page.goto(`/all/operations?service=${service}&range=1h`);

    const rows = page.locator('tbody tr');

    // Order is not asserted here: both ran once, so the default sort by calls
    // is a tie and the tie is the server's to break however it likes.
    await expect(rows).toHaveCount(2);

    await page.getByRole('button', { name: 'p95' }).click();

    // The root span is the slow one, so it leads whichever way round the two
    // arrived.
    await expect(rows.first()).toContainText('GET /slow');
    await expect(rows.nth(1)).toContainText('db.query');
  });

  test('an operation links to the traces it was measured from', async ({ page, request }) => {
    const service = uniqueService('ops-link');

    await seedTrace(request, service, { name: 'GET /linked-op' });

    await page.goto(`/all/operations?service=${service}&range=1h`);
    await page
      .locator('tr', { hasText: 'GET /linked-op' })
      .getByRole('link', { name: 'traces' })
      .click();

    // Both filters, because the row is one operation of one service and the
    // traces page can say exactly that.
    await expect(page).toHaveURL(new RegExp(`service=${service}`));
    await expect(page).toHaveURL(/name=GET\+%2Flinked-op|name=GET%20%2Flinked-op/);
  });

  test('grouping by service answers for the whole service', async ({ page, request }) => {
    const service = uniqueService('ops-service');

    await seedTrace(request, service);

    await page.goto(`/all/operations?service=${service}&by=service&range=1h`);

    // One row, and no operation column at all — the row is the service.
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('thead')).not.toContainText('Operation');
  });

  test('the overview carries latency per service, not just counts', async ({ page, request }) => {
    const service = uniqueService('ops-overview');

    await seedTrace(request, service, { status: 2 });

    await page.goto('/all/services?range=1h');

    const row = page.locator('#services tr', { hasText: service });

    // Duration was on every span from the first one ingested and the overview
    // counted them without ever saying how long any of it took.
    await expect(row).toContainText('ms');
    // One errored span of the two seeded.
    await expect(row).toContainText('50%');
    await expect(row.getByRole('link', { name: 'operations' })).toBeVisible();
  });
});
