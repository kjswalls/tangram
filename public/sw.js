/*
 * Tangram's service worker (PLAN.md §3.6). Hand-written on purpose: a PWA
 * plugin would be a build dependency for ninety lines of cache policy, and the
 * policy is the interesting part.
 *
 * Three rules, in this order:
 *
 *   /api/**            network-only, never cached. The ask route is grounded on
 *                      dictionary rows and the cache that belongs in front of it
 *                      is `ask_cache` in IndexedDB, which stores ids, not prose
 *                      (CLAUDE.md). A second, dumber HTTP cache in front of the
 *                      same route would serve a stale answer for a *different*
 *                      profile.
 *   /_next/static/**   cache-first, no revalidation. The paths are content
 *                      hashed, so a hit is always correct and a miss is a new
 *                      build.
 *   navigations        cache-first with a background refresh, falling back to
 *                      the network and then to whatever shell route is cached.
 *                      This is what makes a review session work on a train.
 *
 * The cache name carries a version. `activate` deletes every cache that is not
 * the current one, which is also how a stale shell (pointing at chunk hashes
 * that no longer exist) gets collected. Bump VERSION whenever the shell or this
 * file changes.
 */

const VERSION = 'v1';
const CACHE = `tangram-${VERSION}`;

/** The routes the app shell is made of (PLAN.md §4: the six nav destinations). */
const SHELL = ['/', '/lookup', '/review', '/read', '/lists', '/settings'];

/** Best-effort: one 404 must not fail the whole install. */
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(
    SHELL.map(async (path) => {
      const response = await fetch(path, { credentials: 'same-origin' });
      if (response.ok) await cache.put(path, response.clone());
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/** Cache-first, and never store a partial or opaque response. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

/** The shell: answer from cache now, refresh in the background for next time. */
async function shell(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (hit) {
    // Do not let the tab close before the refresh lands, but do not wait on it.
    return hit;
  }
  const fresh = await network;
  if (fresh) return fresh;
  const fallback = await cache.match('/');
  if (fallback) return fallback;
  return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never the API, and never the worker or the manifest themselves.
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(shell(request));
  }
});
