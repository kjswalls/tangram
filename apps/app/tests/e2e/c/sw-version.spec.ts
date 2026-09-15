/**
 * The worker's cache name is a hash of the build's own output, and the cache it
 * opens is the only one on the origin (docs/plans/web.md W3; PLAN.md §3.6).
 *
 * While the name was a hand-bumped literal, `activate` — which deletes every
 * cache that is not the current one — purged nothing on a routine build, so
 * every deploy's hashed chunks accumulated. **`web.md` W1 reintroduced that
 * bug**: the name came from `.next/BUILD_ID`, a Vite build does not produce
 * one, and `scripts/build-sw.ts` fell back to stamping every build `dev`.
 * `CLAUDE.md` names it as one of three debts W3 owes. This is the spec that was
 * degraded to an "is it stamped at all" check while the debt stood; it is the
 * real assertion again.
 *
 * What is asserted is the whole of the fix, in the browser rather than in the
 * generator: the worker the server hands out carries the stamp **recomputed
 * from `dist/` here**, the running worker's cache is named after it, and it is
 * the only `tangram-*` cache on the origin. `tests/unit/pwa/build-sw.test.ts`
 * is where the stamp's inputs are pinned.
 */
import { createServer, type Server } from 'node:http';

import { expect, test } from '@playwright/test';

import { readBuildId, precacheList } from '../../../../../scripts/build-sw';

/**
 * Recomputed, never read back out of the artifact it is checking.
 *
 * Reading the stamp off `dist/sw.js` and asserting the served `sw.js` carries
 * it would pass for a worker stamped `dev`, which is exactly the state this
 * spec spent two phases unable to see.
 */
const stamp = readBuildId();

test.describe('the service worker version', () => {
  test('is a content hash of this build, not the dev fallback', async ({ page }) => {
    expect(stamp, 'dist/ has no Vite manifest — run pnpm build').not.toBe('dev');
    expect(stamp).toMatch(/^[a-f0-9]{16}$/);

    const served = await page.request.get('/sw.js');
    expect(served.status()).toBe(200);
    const body = await served.text();

    expect(body).not.toContain('__TANGRAM_BUILD_ID__');
    expect(body).not.toContain('__TANGRAM_PRECACHE__');
    expect(body).toContain(`const VERSION = '${stamp}'`);
  });

  test('precaches this build’s own entry assets, read from the manifest', async ({ page }) => {
    // The list is generated, so the failure it guards against is a `dist/sw.js`
    // left over from an earlier build — which is possible precisely because
    // `vite build` copies `public/` before this script runs.
    const body = await (await page.request.get('/sw.js')).text();
    const shell = precacheList();
    expect(shell.length).toBeGreaterThan(2);
    expect(body).toContain(JSON.stringify(shell));
    for (const path of shell) {
      if (path === '/' || path === '/offline.html') continue;
      expect((await page.request.get(path)).status(), path).toBe(200);
    }
  });

  test('names the cache it keeps, and keeps no other', async ({ page }) => {
    await page.goto('/');
    const names = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      return caches.keys();
    });

    const ours = names.filter((name) => name.startsWith('tangram-'));
    expect(ours).toEqual([`tangram-${stamp}`]);
  });
});

test.describe('what the worker refuses to cache', () => {
  test('never stores the dictionary artifact', async ({ page }) => {
    // It is imported into OPFS (`data.md` D4). An HTTP-cache copy is the same
    // 43 MB again on an origin whose whole storage story is fragile, so the
    // worker denies it by rule. Asserted on the cache's ENTRIES, not on a mock.
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    const manifest = await (await page.request.get('/dict-manifest.json')).json();
    const artifact = `/${manifest.file}`;

    const cached = await page.evaluate(async (path) => {
      const response = await fetch(path);
      await response.arrayBuffer();
      const keys: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) keys.push(new URL(request.url).pathname);
      }
      return keys;
    }, artifact);

    expect(cached).not.toContain(artifact);
    expect(cached.filter((path) => path.endsWith('.sqlite') || path.endsWith('.br'))).toEqual([]);
  });

  test('never answers the configured API origin from a cache', async ({ page }) => {
    // `web.md` W4 moves the API to another origin, and a rule keyed on
    // `pathname.startsWith('/api/')` stops being true the day it does. What
    // actually holds then is the cross-origin bail, so it is exercised here
    // against a real second origin rather than assumed.
    let server: Server | undefined;
    try {
      const port = 3411;
      server = createServer((_req, res) => {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ provider: 'fake' }));
      });
      await new Promise<void>((done) => server!.listen(port, '127.0.0.1', done));

      await page.goto('/');
      await page.evaluate(() => navigator.serviceWorker.ready);

      const cached = await page.evaluate(async (base) => {
        await (await fetch(`${base}/api/ask`)).json();
        const keys: string[] = [];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) keys.push(request.url);
        }
        return keys;
      }, `http://127.0.0.1:${port}`);

      expect(cached.filter((url) => url.includes(`:${port}`))).toEqual([]);
      expect(cached.filter((url) => url.includes('/api/'))).toEqual([]);
    } finally {
      if (server) await new Promise<void>((done) => server!.close(() => done()));
    }
  });
});
