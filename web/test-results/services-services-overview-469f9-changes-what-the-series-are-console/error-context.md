# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: services.spec.ts >> services overview >> grouping changes what the series are
- Location: e2e/services.spec.ts:29:7

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.legend').first()
Expected substring: "e2e-grouping-mud2xnxq"
Received string:    "inventorypaymentscheckout-apistore-refactor-probee2e-logs-mud2ved3e2e-logs-error-mud2vu92Other"

Call log:
  - Expect "toContainText" locator('.legend').first() with timeout 20000ms
  - waiting for locator('.legend').first()
    34 × locator resolved to <ul _ngcontent-ng-c1892754576="" class="legend fx-flex fx-flex-wrap fx-gap-3 fx-m-0 fx-p-0 fx-mt-2">…</ul>
       - unexpected value "inventorypaymentscheckout-apistore-refactor-probee2e-logs-mud2ved3e2e-logs-error-mud2vu92Other"
  - Target page, context or browser has been closed

```

```yaml
- list:
  - listitem: inventory
  - listitem: payments
  - listitem: checkout-api
  - listitem: store-refactor-probe
  - listitem: e2e-logs-mud2ved3
  - listitem: e2e-logs-error-mud2vu92
  - listitem: Other
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | import { seedTrace, uniqueService } from './telemetry';
  4  | 
  5  | test.describe('services overview', () => {
  6  |   test('shows the seeded service and its volume', async ({ page, request }) => {
  7  |     const service = uniqueService('overview');
  8  |     await seedTrace(request, service);
  9  | 
  10 |     await page.goto('/services?range=1h');
  11 | 
  12 |     await expect(page.locator('#services')).toContainText(service);
  13 |     // Tiles read from the same window the charts do.
  14 |     await expect(page.locator('.tile', { hasText: 'Spans' })).not.toContainText('0');
  15 |   });
  16 | 
  17 |   test('the range lives in the URL and a bare link gets the default', async ({ page }) => {
  18 |     await page.goto('/services');
  19 |     await expect(page).toHaveURL(/range=24h/);
  20 | 
  21 |     await page.getByRole('button', { name: '1h', exact: true }).click();
  22 |     await expect(page).toHaveURL(/range=1h/);
  23 | 
  24 |     // A link carries the view it was shared from.
  25 |     await page.goto('/services?range=7d');
  26 |     await expect(page.getByRole('button', { name: '7d', exact: true })).toHaveClass(/active/);
  27 |   });
  28 | 
  29 |   test('grouping changes what the series are', async ({ page, request }) => {
  30 |     const service = uniqueService('grouping');
  31 |     await seedTrace(request, service);
  32 | 
  33 |     await page.goto('/services?range=1h');
  34 |     await expect(page.locator('.legend li').first()).toBeVisible();
> 35 |     await expect(page.locator('.legend').first()).toContainText(service);
     |                                                   ^ Error: expect(locator).toContainText(expected) failed
  36 | 
  37 |     await page.locator('.grouping select').selectOption('environment');
  38 | 
  39 |     // Everything seeded declares `deployment.environment=e2e`, so grouping by it
  40 |     // collapses the services into one series.
  41 |     await expect(page.locator('.legend').first()).toContainText('e2e');
  42 |     await expect(page.locator('.legend').first()).not.toContainText(service);
  43 |   });
  44 | 
  45 |   test('the errors tile arrives at traces with the filter applied', async ({ page }) => {
  46 |     await page.goto('/services?range=1h');
  47 | 
  48 |     await page.locator('.tile', { hasText: 'Errors' }).click();
  49 | 
  50 |     await expect(page).toHaveURL(/\/traces\?.*status=Error/);
  51 |     await expect(page.locator('select')).toHaveValue('Error');
  52 |   });
  53 | });
  54 | 
```