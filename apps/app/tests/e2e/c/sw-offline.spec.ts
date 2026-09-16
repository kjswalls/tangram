/**
 * The worker caches what the page is made of, and offline still renders
 * (PLAN.md §3.6, docs/plans/web.md W1).
 *
 * This exists because of a bug W1 shipped and a green suite did not notice. The
 * cache-first rule was keyed on `/_next/static/`, which a Vite build never
 * emits, so no script or stylesheet ever entered the cache: the worker precached
 * seven HTML documents referencing assets it did not have, and an offline
 * navigation "succeeded" with a blank page. Every unit test passed — one of them
 * asserted the dead rule — and every e2e test passed, because they all ran
 * online.
 *
 * So the assertion is not "the rule contains the right string". It is: go
 * offline and check the page is still there.
 */
import { expect, test } from '@playwright/test';

test.describe('the service worker offline', () => {
  test('caches the hashed assets, not just the documents', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // A second load so the assets go through the worker's fetch handler.
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const ours = names.filter((name) => name.startsWith('tangram-'));
      const keys: string[] = [];
      for (const name of ours) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) keys.push(new URL(request.url).pathname);
      }
      return keys;
    });

    expect(cached.some((path) => path.endsWith('.js')), `cached: ${cached.join(', ')}`).toBe(true);
    expect(cached.some((path) => path.endsWith('.css')), `cached: ${cached.join(', ')}`).toBe(true);
  });

  test('renders a real page with the network down, not a blank one', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    try {
      await page.goto('/');
      // The nav is rendered by React, so seeing it means the document AND its
      // script AND its stylesheet all came out of the cache. A blank page —
      // the bug this is here for — fails on this line.
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Look up' })).toBeVisible();
      const bodyText = (await page.locator('body').innerText()).trim();
      expect(bodyText.length, 'offline page rendered empty').toBeGreaterThan(20);
    } finally {
      await context.setOffline(false);
    }
  });
});
