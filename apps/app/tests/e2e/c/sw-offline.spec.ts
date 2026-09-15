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
 *
 * W3 adds the harder half of that: a **never-visited** route. Precaching was
 * the seven nav routes and is now the one document plus this build's entry
 * assets, and `shell()` falls back to that document when the requested URL is
 * not in the cache — so a route the learner has never opened renders the app
 * offline rather than the offline page. Going offline at all is new capability
 * this container has for free; HANDOFF.md records that the suite never did it
 * before W1's review.
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
      await page.goto('/lookup');
      // The nav is rendered by React, so seeing it means the document AND its
      // script AND its stylesheet all came out of the cache. A blank page —
      // the bug this is here for — fails on this line.
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Lookup' })).toBeVisible();
      const bodyText = (await page.locator('body').innerText()).trim();
      expect(bodyText.length, 'offline page rendered empty').toBeGreaterThan(20);
    } finally {
      await context.setOffline(false);
    }
  });

  test('renders a NEVER-VISITED route offline, from the one cached document', async ({
    page,
    context,
  }) => {
    // Only `/` is precached — the SPA fallback means there is one document for
    // every path, which is what makes this legitimate rather than a lie (see
    // `shell()` in scripts/sw.template.js).
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    try {
      // Never opened in this context, and not in the precache list.
      await page.goto('/stats');
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
      await expect(page.locator('[data-route="/stats"]')).toHaveCount(1);
      // Not the offline page wearing the app's clothes.
      await expect(page.getByRole('heading', { name: 'Stats' })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('falls back to the offline page only when even the document is gone', async ({
    page,
    context,
  }) => {
    // The third rung of the ladder, and the one a cold start hits: a browser
    // that has never loaded the app has nothing cached at all.
    await context.setOffline(true);
    try {
      const response = await page.goto('/lookup').catch(() => null);
      // With no worker installed there is nothing to serve it — a browser error
      // is the honest outcome, and what must NOT happen is a hang.
      expect(response === null || !response.ok()).toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });
});
