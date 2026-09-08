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
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const buildId = readFileSync(resolve(process.cwd(), '.next/BUILD_ID'), 'utf8').trim();

test.describe('the service worker version', () => {
  test('is the id of the build that produced it', async ({ page }) => {
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
