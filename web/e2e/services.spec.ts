import { expect, test } from '@playwright/test';

import { seedTrace, uniqueService } from './telemetry';

test.describe('services overview', () => {
  test('shows the seeded service and its volume', async ({ page, request }) => {
    const service = uniqueService('overview');
    await seedTrace(request, service);

    await page.goto('/services?range=1h');

    await expect(page.locator('#services')).toContainText(service);
    // Tiles read from the same window the charts do.
    await expect(page.locator('.tile', { hasText: 'Spans' })).not.toContainText('0');
  });

  test('the range lives in the URL and a bare link gets the default', async ({ page }) => {
    await page.goto('/services');
    await expect(page).toHaveURL(/range=24h/);

    await page.getByRole('button', { name: '1h', exact: true }).click();
    await expect(page).toHaveURL(/range=1h/);

    // A link carries the view it was shared from.
    await page.goto('/services?range=7d');
    await expect(page.getByRole('button', { name: '7d', exact: true })).toHaveClass(/active/);
  });

  test('grouping changes what the series are', async ({ page, request }) => {
    const service = uniqueService('grouping');
    await seedTrace(request, service);

    await page.goto('/services?range=1h');
    await expect(page.locator('.legend li').first()).toBeVisible();
    await expect(page.locator('.legend').first()).toContainText(service);

    await page.locator('.grouping select').selectOption('environment');

    // Everything seeded declares `deployment.environment=e2e`, so grouping by it
    // collapses the services into one series.
    await expect(page.locator('.legend').first()).toContainText('e2e');
    await expect(page.locator('.legend').first()).not.toContainText(service);
  });

  test('the errors tile arrives at traces with the filter applied', async ({ page }) => {
    await page.goto('/services?range=1h');

    await page.locator('.tile', { hasText: 'Errors' }).click();

    await expect(page).toHaveURL(/\/traces\?.*status=Error/);
    await expect(page.locator('select')).toHaveValue('Error');
  });
});
