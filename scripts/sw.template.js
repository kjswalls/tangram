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
 *   navigations        **network-first**, with the cache as the offline
 *                      fallback and `/offline.html` behind that. This is what
 *                      makes a review session work on a train.
 *
 * Navigations are network-first and that is the load-bearing choice. Cache-first
 * looks cheaper and is wrong: a document cached before a deploy references
 * `/_next/static/chunks/<old-hash>.js` that the new deployment no longer serves,
 * so the first visit to every route after every deploy renders a page that never
 * hydrates. Binding the cache name to the build (below) closes most of that —
 * the old cache is dropped on activate — but not the window before the new
 * worker activates, and a cached document is a document from whenever it was
 * cached whatever the cache is called. Answering from the network whenever there
 * *is* a network removes the whole class, and costs nothing offline, where the
 * cached copy is still what gets served.
 *
 * The cache name carries the build's own id. This file is a **template**:
 * `scripts/build-sw.ts` writes `public/sw.js` from it after `next build`,
 * substituting the id Next just generated (`.next/BUILD_ID`) for the
 * placeholder below. That is what makes `activate` — which deletes every cache
 * that is not the current one — collect the *previous* build's hashed chunks
 * instead of leaving them to accumulate deploy after deploy. A hand-bumped
 * literal purged only when somebody remembered to change it, which on a routine
 * build is never.
 *
 * Editing the served worker means editing this file; `public/sw.js` is
 * generated and gitignored, and a hand edit to it is overwritten by the next
 * build.
 */

const VERSION = '__TANGRAM_BUILD_ID__';
const CACHE = `tangram-${VERSION}`;

/** Served for a navigation we have never cached while the network is down. */
const OFFLINE_URL = '/offline.html';

/** The routes the app shell is made of — every nav destination (`NAV_ITEMS`). */
const SHELL = ['/', '/lookup', '/review', '/read', '/lists', '/stats', '/settings', OFFLINE_URL];

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

/** Only a complete, same-origin response is ever worth storing. */
function storable(response) {
  return Boolean(response) && response.ok && response.type === 'basic';
}

/** Cache-first, and never store a partial or opaque response. */
async function cacheFirst(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Hold the worker open for the write, but do not make the page wait on it.
  if (storable(response)) event.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * The shell: the network decides, the cache catches. Offline (or on a network
 * error) the last good copy of this exact route is served, then the offline
 * page — never another route's HTML under this route's URL.
 */
async function shell(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (storable(response)) event.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
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
    event.respondWith(cacheFirst(event));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(shell(event));
  }
});
