import { expect, Page, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

/** The tile with exactly this label. Filtering by text alone is ambiguous:
 * the Errors tile explains itself as "n in spans, n in logs", so it matches a
 * search for "Spans" too. */
function tile(page: Page, label: string) {
  return page.locator('.tile').filter({ has: page.getByText(label, { exact: true }) });
}

test.describe('services overview', () => {
  test('shows the seeded service and its volume', async ({ page, request }) => {
    const service = uniqueService('overview');
    await seedTrace(request, service);

    await page.goto('/all/services?range=1h');

    await expect(page.locator('#services')).toContainText(service);
    // Tiles read from the same window the charts do.
    await expect(tile(page, 'Spans')).not.toContainText('0');
  });

  test('the range lives in the URL and a bare link gets the default', async ({ page }) => {
    await page.goto('/all/services');
    await expect(page).toHaveURL(/range=24h/);

    await page.getByRole('radio', { name: '1h', exact: true }).click();
    await expect(page).toHaveURL(/range=1h/);

    // A link carries the view it was shared from.
    await page.goto('/all/services?range=7d');
    await expect(page.getByRole('radio', { name: '7d', exact: true })).toBeChecked();
  });

  test('grouping changes what the series are', async ({ page, request }) => {
    await seedTrace(request, uniqueService('grouping-one'));
    await seedTrace(request, uniqueService('grouping-two'));

    await page.goto('/all/services?range=1h');

    // Not "the service I just seeded is in the legend": the chart keeps the
    // largest series and buckets the rest as Other, so a quiet new service is
    // legitimately absent. What grouping promises is the shape of the split.
    const legend = page.locator('.legend').first();

    await expect(legend.locator('li').first()).toBeVisible();
    expect(await legend.locator('li').count()).toBeGreaterThan(1);

    await page.getByRole('combobox', { name: 'Group by' }).click();
    await page.getByRole('option', { name: 'Environment' }).click();

    // Everything seeded declares `deployment.environment=e2e`, and anything
    // that declares no environment is dropped rather than drawn as a blank —
    // so grouping by it collapses the services into exactly one series.
    await expect(legend.locator('li')).toHaveCount(1);
    await expect(legend.locator('li')).toHaveText('e2e');
  });

  test('the errors tile arrives at the signal that has the errors', async ({ page, request }) => {
    // Seeded rather than assumed: the tile counts errors across spans and logs,
    // and which page it links to depends on which of the two it found. An
    // errored span is what sends it to Traces.
    await seedTrace(request, uniqueService('erroring'), { status: 2 });

    await page.goto('/all/services?range=1h');

    await expect(tile(page, 'Errors')).toContainText('in spans');
    await tile(page, 'Errors').click();

    await expect(page).toHaveURL(/\/all\/traces\?.*status=Error/);
    await expect(page.getByRole('combobox', { name: 'Status' })).toContainText('Error');
  });

  test('a service row links to its own telemetry, under the same app', async ({ page, request }) => {
    const service = uniqueService('linked-row');
    await seedTrace(request, service);

    await page.goto('/all/services?range=1h');

    // Every in-page link carries the scope. An absolute /traces does not merely
    // lose the app — it matches :appId and looks for an app called "traces".
    const row = page.locator('#services tr', { hasText: service });

    await expect(row.getByRole('link', { name: 'traces' })).toHaveAttribute(
      'href',
      `/all/traces?service=${service}`,
    );

    await row.getByRole('link', { name: 'logs' }).click();
    await expect(page).toHaveURL(`/all/logs?service=${service}`);
  });
});
