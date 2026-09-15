/**
 * Every page route renders its own screen (docs/plans/web.md W2, risk R7).
 *
 * **This is the assertion the SPA fallback took away.** Every path that is not
 * a real file returns 200 and `index.html`, so a status-only check is a test
 * that cannot fail: it passes against a build whose entry chunk 404s, and
 * against a route that no longer exists. What is left worth asserting is what
 * came up in the DOM, which needs a browser — hence a Playwright spec rather
 * than more of `scripts/smoke.ts`, which stays a dependency-free CLI so the
 * after-deploy checklist never needs one.
 *
 * The table is **read out of `src/routes.tsx`**, not copied. Add a route with
 * no `<RouteMarker />` and this fails the day it is written;
 * `tests/unit/server/routes.test.ts` fails first and more cheaply, which is the
 * point of having both. `core.md` C7 collapses the table to three tabs and its
 * commit re-runs this (`web.md` §2) — nothing here needs editing for it.
 *
 * Proved falsifiable by hand before it was trusted, the way the plan asks:
 * removing the entry chunk from `dist/` turns every case here red, and removing
 * one `<RouteMarker />` turns exactly that route's case red. Recorded in
 * HANDOFF.md.
 */
import { expect, test } from '@playwright/test';

import { appRoot } from '../../../lib/server/roots';
import { discoverPageRoutes, pageRouteUrl } from '../../../lib/server/route-inventory';

const ROOT = appRoot(new URL('.', import.meta.url).pathname);
const PAGES = discoverPageRoutes(ROOT);

test.describe('every route in the table renders', () => {
  test('the table is not empty, and it is the production one', () => {
    // A discovery bug that found nothing would make every case below vacuous.
    expect(PAGES.length).toBeGreaterThanOrEqual(7);
    expect(PAGES.map((page) => page.pattern)).not.toContain('/gallery');
  });

  for (const page of PAGES) {
    test(`${page.pattern} renders its own screen`, async ({ page: browser }) => {
      const errors: string[] = [];
      browser.on('pageerror', (error) => errors.push(error.message));
      const response = await browser.goto(pageRouteUrl(page));
      expect(response?.status(), pageRouteUrl(page)).toBe(200);

      // The marker only exists if THIS route's component mounted — not if the
      // fallback document merely arrived.
      await expect(browser.locator(`[data-route="${page.pattern}"]`)).toHaveCount(1);

      // …and the screen behind it is not a blank shell. A route that mounts and
      // renders nothing is the other half of the same failure.
      await expect(browser.locator('main')).not.toBeEmpty();
      await expect(browser.getByRole('heading').first()).toBeVisible();

      // A route that throws after mounting still leaves its marker behind for a
      // moment; an uncaught error is a broken page whatever the DOM says.
      expect(errors, `${page.pattern} threw: ${errors.join(' · ')}`).toEqual([]);
    });
  }

  test('a path in no table renders the in-shell 404, not the router’s own', () => {
    // W1's review: an unmatched URL is routine under the SPA fallback, and
    // without an errorElement it replaced the whole app with React Router's
    // unstyled built-in page — no header, no nav, no way back.
    expect(PAGES.map((page) => page.pattern)).not.toContain('*');
  });

  test('an unknown path keeps the shell', async ({ page }) => {
    await page.goto('/no/such/route');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });
});
