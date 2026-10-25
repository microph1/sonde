import { expect, test } from '@playwright/test';

import { seedGauge, seedHistogram, uniqueService } from './telemetry';

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

  test('a histogram draws its distribution, not an empty chart', async ({ page, request }) => {
    const service = uniqueService('hist');
    const family = `e2e.latency.${Date.now().toString(36)}`;

    await seedHistogram(request, service, `${family}.duration`);

    await page.goto('/all/metrics?range=1h');

    const card = page.locator('.card', { hasText: family });

    // The card reports the same reading the chart opens on. It used to say
    // `rate 0/s`, which answers a question nobody asked of an instrument whose
    // purpose is how long things take.
    await expect(card).toContainText('p95');
    await expect(card).not.toContainText('/s');

    await card.click();

    // Every histogram used to answer `Unknown identifier 'Value'` and draw a
    // flat line at zero, silently: the detail query asked a column the table
    // does not have. They are the latency instruments, so they were the ones
    // most worth looking at and the only ones you could not.
    await expect(page.locator('.detail .legend')).toContainText('route=/seeded');
    await expect(page.locator('.detail')).not.toContainText('Nothing reported');

    // What the window held, beside the percentile estimated from it: `Sum`,
    // `Min` and `Max` are reported by the instrument outright and were read by
    // nothing. Two observations, seeded a minute apart as one cumulative
    // stream.
    await expect(page.locator('.window')).toContainText('2 observations');
    await expect(page.locator('.window')).toContainText('fastest');
    await expect(page.locator('.window')).toContainText('worst');

    // A distribution has no single value, so the line is always a choice.
    await expect(page.getByRole('radio', { name: 'p99' })).toBeVisible();
    await page.getByRole('radio', { name: 'p50' }).click();
    await expect(page.locator('.detail .legend')).toContainText('route=/seeded');
  });

  test('a metric can be split by one attribute and filtered by another', async ({
    page,
    request,
  }) => {
    const service = uniqueService('split');
    const family = `e2e.split.${Date.now().toString(36)}`;

    await seedHistogram(request, service, `${family}.duration`);

    await page.goto('/all/metrics?range=1h');
    await page.locator('.card', { hasText: family }).click();

    // A series was the whole attribute set and only that, so a metric with
    // dozens of combinations drew six lines and an "Other" and there was no
    // way to ask for the one split you came for.
    await expect(page.locator('.detail .legend')).toContainText('route=/seeded');
    await expect(page.locator('.detail .legend')).toContainText('outcome=ok');

    await page.locator('.breakdown .split mat-select').click();
    await page.getByRole('option', { name: 'route' }).click();
    await page.keyboard.press('Escape');

    await expect(page.locator('.detail .legend')).toContainText('route=/seeded');
    await expect(page.locator('.detail .legend')).not.toContainText('outcome=');

    // And the filter keeps only what was asked for: a value nothing carries
    // leaves an honestly empty chart rather than an unfiltered one.
    await page.locator('.breakdown .filter', { hasText: 'outcome' }).locator('mat-select').click();
    await page.getByRole('option', { name: 'ok', exact: true }).click();
    await page.keyboard.press('Escape');

    await expect(page.locator('.detail .legend')).toContainText('route=/seeded');
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
