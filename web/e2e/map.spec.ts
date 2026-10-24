import { expect, Page, test } from '@playwright/test';

import { seedCall, uniqueService } from './telemetry';

/** The scale out of the transform the whole drawing rides on. */
async function scale(page: Page): Promise<number> {
  const transform = await page.locator('figure.map svg > g').getAttribute('transform');

  return Number(/scale\(([^)]+)\)/.exec(transform ?? '')?.[1] ?? NaN);
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
    await expect(page.locator('figure.map svg')).toContainText(caller);
  });

  test('the map zooms and goes back to fitting the frame', async ({ page, request }) => {
    await seedCall(request, uniqueService('zoom-from'), uniqueService('zoom-to'));

    await page.goto('/all/map');
    await expect(page.locator('figure.map svg > g')).toBeVisible();

    expect(await scale(page)).toBe(1);

    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => scale(page)).toBeGreaterThan(1);

    // The button only exists once there is something to go back from.
    await page.getByRole('button', { name: 'Fit the map to the frame' }).click();
    await expect.poll(() => scale(page)).toBe(1);
    await expect(page.getByRole('button', { name: 'Fit the map to the frame' })).toBeHidden();
  });

  test('dragging the map pans it rather than opening a node', async ({ page, request }) => {
    const caller = uniqueService('drag-from');

    await seedCall(request, caller, uniqueService('drag-to'));

    await page.goto('/all/map');

    // `hover` rather than arithmetic on a bounding box: it scrolls the target
    // into view and positions the pointer on it, which matters because the
    // whole graph is scaled into a fixed frame and a node on a crowded map is
    // only a few pixels across.
    await page.locator('g.node', { hasText: caller }).locator('circle').hover();

    await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 6 });
    await page.mouse.up();

    // Letting go after a drag used to open the node the pointer went down on,
    // which is what makes a draggable thing feel broken.
    await expect(page).toHaveURL(/\/all\/map$/);
  });

  test('a drag moves the drawing under the frame', async ({ page, request }) => {
    await seedCall(request, uniqueService('pan-from'), uniqueService('pan-to'));

    await page.goto('/all/map');

    const figure = page.locator('figure.map');
    const box = await figure.boundingBox();

    expect(box, 'the map should be on the page').not.toBeNull();

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 90, box!.y + box!.height / 2 + 40, { steps: 6 });
    await page.mouse.up();

    await expect(page.locator('figure.map svg > g')).not.toHaveAttribute(
      'transform',
      /translate\(0 0\)/,
    );
  });

  test('a node still links to its traces when clicked', async ({ page, request }) => {
    const caller = uniqueService('click-from');

    await seedCall(request, caller, uniqueService('click-to'));

    await page.goto('/all/map');
    // The circle, not the group: a group's box includes the gap between the
    // node and its label, and nothing is painted there to click.
    await page.locator('g.node', { hasText: caller }).locator('circle').click();

    await expect(page).toHaveURL(new RegExp(`/all/traces\\?service=${caller}`));
  });
});
