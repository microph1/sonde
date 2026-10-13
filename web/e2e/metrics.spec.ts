import { expect, test } from '@playwright/test';

import { seedGauge, uniqueService } from './telemetry';

test.describe('metrics', () => {
  test('lists a seeded instrument and draws it when picked', async ({ page, request }) => {
    const service = uniqueService('gauge');
    // The last segment is the reading; what the card is named for is the scope
    // above it.
    const family = `e2e.gauge.${Date.now().toString(36)}`;

    await seedGauge(request, service, `${family}.value`, 42);

    await page.goto('/all/metrics?range=1h');

    const card = page.locator('.card', { hasText: family });

    await expect(card).toBeVisible();
    await card.click();

    await expect(page.locator('.detail')).toContainText(family);
    await expect(page.locator('.detail')).toContainText('seeded by the e2e suite');
  });

  test('a service that only reports metrics is not a dead service', async ({ page, request }) => {
    const service = uniqueService('metrics-only');

    // No spans and no logs, on purpose: counting those two alone had a service
    // exporting every fifteen seconds reading as last seen hours ago, and the
    // overview was believed.
    await seedGauge(request, service, `e2e.only.${Date.now().toString(36)}.value`);

    await page.goto('/all/services?range=1h');

    const row = page.locator('#services tr', { hasText: service });

    await expect(row).toBeVisible();
    await expect(row.getByRole('link', { name: 'metrics' })).toBeVisible();
  });
});
