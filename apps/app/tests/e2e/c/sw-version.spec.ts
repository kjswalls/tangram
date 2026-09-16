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

test.describe('the purge, which is the whole reason the name changes', () => {
  test('activate drops every cache that is not this build’s', async ({ page }) => {
    // W3's third acceptance bullet is "…**and after the next activate the cache
    // named for the old stamp is gone**". The review found that half asserted
    // nowhere: every Playwright test starts with empty CacheStorage, so
    // `caches.keys()` returns one name whatever `activate` does — deleting the
    // purge loop from the template changed nothing. So this puts a previous
    // build's cache there first, and then forces a new worker to activate.
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    const left = await page.evaluate(async () => {
      // Two names a previous deploy would have left behind.
      await caches.open('tangram-0000000000000000');
      await caches.open('tangram-ffffffffffffffff');

      // Force a genuinely NEW worker to install and activate. Unregistering
      // and re-registering the same URL does not reliably do it — the browser
      // may reuse the existing worker, and the running one has already
      // activated and will not do it twice. Registering a different script URL
      // at the same scope replaces the registration, so `install` runs,
      // `skipWaiting()` fires, and `activate` — the purge — runs with it. The
      // worker's own bytes are unchanged; only the URL it was fetched from is.
      await navigator.serviceWorker.register('/sw.js?purge-check');
      await navigator.serviceWorker.ready;

      // Poll rather than sleep: `activate` runs after `install` resolves, and
      // how long that takes depends on how fast the precache fetches come back.
      // A fixed wait either flakes or is slow; this fails on the timeout if the
      // purge never happens, which is the assertion.
      const stale = ['tangram-0000000000000000', 'tangram-ffffffffffffffff'];
      for (let i = 0; i < 100; i += 1) {
        const names = await caches.keys();
        if (!stale.some((name) => names.includes(name))) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      return (await caches.keys()).filter((name) => name.startsWith('tangram-'));
    });

    expect(left, 'the previous builds’ caches survived activate').toEqual([`tangram-${stamp}`]);
  });
});

test.describe('what the worker refuses to cache', () => {
  test('never stores the dictionary artifact, even navigated to directly', async ({ page }) => {
    // It is imported into OPFS (`data.md` D4). An HTTP-cache copy is the same
    // 43 MB again on an origin whose whole storage story is fragile.
    //
    // **This case cannot fail on the deny rule alone, and pretending otherwise
    // would be the same sin the review caught.** Checked by deleting the rule
    // from the template, rebuilding and re-running: still green. Two other
    // things already prevent the outcome — the artifact's path matches no
    // cache-first rule, and `storable()` refuses anything that is not a basic
    // ok response — and a navigation to it is a *download* in Chromium, which
    // bypasses the worker entirely. So the deny is defence in depth: it is what
    // holds the day somebody widens a cache rule, which is exactly the day
    // nobody is looking at it. What guards its presence and its position ahead
    // of the cache-first rules is `tests/unit/pwa/manifest.test.ts`, anchored
    // on the rule's own text. This case is the criterion's own wording —
    // assert on the cache's ENTRIES, not on a mock — and is worth keeping as
    // the statement of the outcome that must never change.
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    const manifest = await (await page.request.get('/dict-manifest.json')).json();
    const artifact = `/${manifest.file}`;

    await page.goto(artifact).catch(() => null);
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);

    const cached = await page.evaluate(async () => {
      const keys: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) keys.push(new URL(request.url).pathname);
      }
      return keys;
    });

    expect(cached).not.toContain(artifact);
    expect(cached.filter((path) => path.endsWith('.sqlite') || path.endsWith('.br'))).toEqual([]);
  });

  test('stores nothing from another origin, whatever path it is on', async ({ page }) => {
    // `web.md` W4 moves the API to another origin, and a rule keyed on
    // `pathname.startsWith('/api/')` stops being true the day it does. The
    // cross-origin bail is what still holds then, so it has to be exercised
    // against a real second origin.
    //
    // **The path is `/assets/…` deliberately** — the one prefix the worker
    // caches, so this is the closest a cross-origin request can come to being
    // cached. It still cannot fail on the bail alone, and that was checked the
    // same way: with the bail deleted the request reaches `cacheFirst`, but a
    // cross-origin response has `type: 'cors'` (or is opaque), and `storable()`
    // refuses anything that is not `basic`. Layers, and the outer one is the
    // one this asserts. The bail's own presence and its position ahead of every
    // cache rule are asserted on the source in
    // `tests/unit/pwa/manifest.test.ts`.
    let server: Server | undefined;
    try {
      const port = 3411;
      server = createServer((req, res) => {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader(
          'content-type',
          req.url?.endsWith('.js') ? 'text/javascript' : 'application/json',
        );
        res.end(req.url?.endsWith('.js') ? 'export const other = 1;' : '{"provider":"fake"}');
      });
      await new Promise<void>((done) => server!.listen(port, '127.0.0.1', done));
      const other = `http://127.0.0.1:${port}`;

      await page.goto('/');
      await page.evaluate(() => navigator.serviceWorker.ready);

      const cached = await page.evaluate(async (base) => {
        // The path the worker caches, on an origin it must not.
        await (await fetch(`${base}/assets/other-DEADBEEF.js`)).text();
        await (await fetch(`${base}/api/ask`)).json();
        const keys: string[] = [];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) keys.push(request.url);
        }
        return keys;
      }, other);

      expect(cached.filter((url) => url.includes(`:${port}`))).toEqual([]);
      // …and nothing else foreign got in either, which is the general statement
      // the rule actually makes.
      const origin = new URL(page.url()).origin;
      expect(cached.filter((url) => new URL(url).origin !== origin)).toEqual([]);
    } finally {
      if (server) await new Promise<void>((done) => server!.close(() => done()));
    }
  });
});
