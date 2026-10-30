import { expect, Page, test } from '@playwright/test';

import { seedCall, uniqueService } from './telemetry';

/** The scale out of the transform the whole drawing rides on. */
async function scale(page: Page): Promise<number> {
  const transform = await page.locator('figure.map g[mapContext]').getAttribute('transform');

  return Number(/scale\(([^)]+)\)/.exec(transform ?? '')?.[1] ?? NaN);
}

/**
 * A node by the service it stands for.
 *
 * The circle and its name are one element, and it is ordinary HTML rather than
 * SVG — the flow renders nodes into a foreignObject so they can be styled and
 * read like the rest of the page.
 */
function node(page: Page, service: string) {
  return page.locator('figure.map .node').filter({ hasText: service }).first();
}

test.describe('map', () => {
  test('draws an edge for a call that crossed services', async ({ page, request }) => {
    const caller = uniqueService('caller');
    const callee = uniqueService('callee');

    await seedCall(request, caller, callee);

    await page.goto('/all/map');

    const row = page.locator('tr', { hasText: caller });

    await expect(row).toContainText(callee);
    // The table is the drawing's twin, not its fallback, so both have to say it.
    await expect(node(page, caller)).toBeVisible();
    await expect(node(page, callee)).toBeVisible();
  });

  test('the map zooms and goes back to fitting the frame', async ({ page, request }) => {
    await seedCall(request, uniqueService('zoom-from'), uniqueService('zoom-to'));

    await page.goto('/all/map');
    await expect(page.locator('figure.map g[mapContext]')).toBeVisible();

    // The graph is scaled to fill the frame, so the resting scale is whatever
    // that took rather than 1. What matters is that going back returns to it.
    await expect.poll(() => scale(page)).toBeGreaterThan(0);

    const fitted = await scale(page);

    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => scale(page)).toBeGreaterThan(fitted);

    await page.getByRole('button', { name: 'Put the map back as it was laid out' }).click();
    await expect.poll(() => scale(page)).toBeCloseTo(fitted, 4);
  });

  test('dragging a node moves it rather than opening it', async ({ page, request }) => {
    const caller = uniqueService('drag-from');

    await seedCall(request, caller, uniqueService('drag-to'));

    await page.goto('/all/map');

    const dragged = node(page, caller);

    await expect(dragged).toBeVisible();

    const before = await dragged.boundingBox();

    // `hover` rather than arithmetic on a bounding box: it scrolls the target
    // into view and positions the pointer on it, which matters because the
    // whole graph is scaled into a fixed frame and a node on a crowded map is
    // only a few pixels across.
    await dragged.hover();
    await page.mouse.down();
    await page.mouse.move(before!.x + 120, before!.y + 80, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => (await dragged.boundingBox())?.x)
      .not.toBeCloseTo(before!.x, 0);

    // Letting go after a drag used to open the node the pointer went down on,
    // which is what makes a draggable thing feel broken.
    await expect(page).toHaveURL(/\/all\/map$/);
  });

  test('a drag of the background moves the drawing under the frame', async ({ page, request }) => {
    await seedCall(request, uniqueService('pan-from'), uniqueService('pan-to'));

    await page.goto('/all/map');
    await expect(page.locator('figure.map .node').first()).toBeVisible();

    const figure = page.locator('figure.map');
    const box = await figure.boundingBox();

    expect(box, 'the map should be on the page').not.toBeNull();

    const before = await page.locator('figure.map g[mapContext]').getAttribute('transform');

    // Low in the frame, where the graph itself is not: a drag that starts on a
    // node moves the node instead, which is a different test.
    const y = box!.y + box!.height - 40;

    await page.mouse.move(box!.x + box!.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 90, y - 40, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(() => page.locator('figure.map g[mapContext]').getAttribute('transform'))
      .not.toBe(before);
  });

  test('a node still links to its traces when clicked', async ({ page, request }) => {
    const caller = uniqueService('click-from');

    await seedCall(request, caller, uniqueService('click-to'));

    await page.goto('/all/map');
    await node(page, caller).click();

    await expect(page).toHaveURL(new RegExp(`/all/traces\\?service=${caller}`));
  });
});
