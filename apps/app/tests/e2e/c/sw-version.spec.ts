/**
 * The worker's cache name is the build's id (PLAN.md §3.6; HANDOFF.md, Phase 6
 * review fixes 2, "Not fixed, on purpose").
 *
 * While the name was a hand-bumped literal, `activate` — which deletes every
 * cache that is not the current one — purged nothing on a routine build, so
 * every deploy's hashed chunks accumulated in one cache. What is asserted here
 * is the whole of the fix: the worker the server hands out carries the id of
 * the build that produced it, and the cache the running worker opens is named
 * after that id and is the only `tangram-*` cache on the origin.
 *
 * **Degraded between W1 and W3, deliberately, and this is the whole of it.**
 * The id came from `.next/BUILD_ID`, which a Vite build does not produce
 * (docs/STACK.md §2.2). `scripts/build-sw.ts` therefore falls back to its
 * `DEV_BUILD_ID` stamp on every build, so the name no longer *changes* when the
 * output does — which is precisely the bug this spec was written to catch, now
 * latent. What survives here is that the stamping mechanism still runs and that
 * the running worker keeps exactly one cache. **`web.md` W3 restamps it from a
 * hash of Vite's own output and restores the real assertion**; until then the
 * regression is recorded in HANDOFF.md rather than hidden by a green spec.
 */
import { expect, test } from '@playwright/test';

import { DEV_BUILD_ID } from '../../../../../scripts/build-sw';

const buildId = DEV_BUILD_ID;

test.describe('the service worker version', () => {
  test('is stamped, not left as the template placeholder', async ({ page }) => {
    const served = await page.request.get('/sw.js');
    expect(served.status()).toBe(200);
    const body = await served.text();

    expect(body).not.toContain('__TANGRAM_BUILD_ID__');
    expect(body).toContain(`const VERSION = '${buildId}'`);
  });

  test('names the cache it keeps, and keeps no other', async ({ page }) => {
    await page.goto('/');
    const names = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      return caches.keys();
    });

    const ours = names.filter((name) => name.startsWith('tangram-'));
    expect(ours).toEqual([`tangram-${buildId}`]);
  });
});
