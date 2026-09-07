import { expect, test, type Page } from '@playwright/test';

/** The six routes of PLAN.md §4, and the heading each one opens with. */
const ROUTES = [
  { path: '/', label: 'Today', heading: 'Today' },
  { path: '/lookup', label: 'Lookup', heading: 'Lookup' },
  { path: '/review', label: 'Review', heading: 'Review' },
  { path: '/read', label: 'Read', heading: 'Read' },
  { path: '/lists', label: 'Lists', heading: 'Lists' },
  { path: '/settings', label: 'Settings', heading: 'Settings' },
] as const;

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test.describe('app shell', () => {
  for (const route of ROUTES) {
    test(`${route.path} renders its heading and the full nav`, async ({ page }) => {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      for (const item of ROUTES) {
        await expect(nav(page).getByRole('link', { name: item.label, exact: true })).toBeVisible();
      }
    });
  }

  test('the nav marks the route you are on', async ({ page }) => {
    await page.goto('/lists');
    await expect(nav(page).getByRole('link', { name: 'Lists', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav(page).getByRole('link', { name: 'Today', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the nav walks every route', async ({ page }) => {
    await page.goto('/');
    for (const route of ROUTES.slice(1)) {
      await nav(page).getByRole('link', { name: route.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${route.path}$`));
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    }
  });

  test('/lookup renders the panel shell with its slot contract', async ({ page }) => {
    await page.goto('/lookup');
    await expect(page.getByTestId('lookup-panel')).toBeVisible();
    await expect(page.getByTestId('lookup-body')).toBeVisible();
    // Nothing injects the slot, and with no query there is nothing to ask
    // about either: both ask regions are absent on a bare /lookup.
    await expect(page.getByTestId('lookup-ask-slot')).toHaveCount(0);
    await expect(page.getByTestId('lookup-ask')).toHaveCount(0);
  });

  test('a 503 from the dictionary raises the "run pnpm data" banner', async ({ page }) => {
    // Deterministic stand-in for a missing data/ directory (PLAN.md §3.2).
    await page.route('**/api/dict/hsk*', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'dict-data-missing', hint: 'run pnpm data' }),
      }),
    );
    await page.goto('/');
    await expect(page.getByTestId('data-banner')).toContainText('pnpm data');
  });

  test('no banner when the dictionary answers', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(page.getByTestId('data-banner')).toHaveCount(0);
  });

  test('/settings carries the licences section, rendered as prose', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Licenses' })).toBeVisible();
    // ATTRIBUTION.md is Markdown: it must not reach the page as raw `##` and `**`.
    await expect(page.getByRole('heading', { name: /CC-CEDICT/ })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('## CC-CEDICT');
  });

  test('the nav fits a 390px phone', async ({ page }) => {
    // The six links used to total 381px in a 366px row and scroll silently, so
    // the last one read "Setting" with no affordance to reach the rest.
    const width = 390;
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    for (const route of ROUTES) {
      const link = nav(page).getByRole('link', { name: route.label, exact: true });
      const box = await link.boundingBox();
      if (!box) throw new Error(`${route.label} has no box`);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(32);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the tab icon exists, so no route 404s on a favicon', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel~="icon"]')).toHaveCount(1);
    expect((await page.request.get('/icon.svg')).status()).toBe(200);
  });
});
