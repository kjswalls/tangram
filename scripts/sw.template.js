/*
 * Tangram's service worker (PLAN.md §3.6). Hand-written on purpose: a PWA
 * plugin would be a build dependency for ninety lines of cache policy, and the
 * policy is the interesting part.
 *
 * Five rules, in this order:
 *
 *   cross-origin       returned before `respondWith`. From `web.md` W4 the API
 *                      lives on another origin, and a rule keyed on
 *                      `pathname.startsWith('/api/')` stops being true the day
 *                      it moves — so the cross-origin bail is what actually
 *                      keeps the API out of this cache, and the `/api/` rule
 *                      below is what keeps it out until then. Both, on purpose.
 *   /api/**            network-only, never cached. The ask route is grounded on
 *                      dictionary rows and the cache that belongs in front of it
 *                      is `ask_cache` in IndexedDB, which stores ids, not prose
 *                      (CLAUDE.md). A second, dumber HTTP cache in front of the
 *                      same route would serve a stale answer for a *different*
 *                      profile.
 *   the dictionary     **denied outright.** `dict-<schema>-<version>.sqlite` is
 *                      43 MB and its brotli sibling 17 MB, and the browser
 *                      imports it into OPFS (`data.md` D4). An HTTP-cache copy
 *                      is the same tens of megabytes a second time, on an origin
 *                      whose whole storage story is fragile. Not optional.
 *   /assets/**         cache-first, no revalidation. The paths are content
 *                      hashed, so a hit is always correct and a miss is a new
 *                      build. Note what the PREFIX excludes: anything copied
 *                      verbatim out of `publicDir` keeps its authored path and
 *                      is not matched by it, so anything else worth caching
 *                      needs its own rule — `/decomp.json` is the one case.
 *   /decomp.json       cache-first too, although it is NOT content-addressed.
 *                      Safe only because its bytes are part of the cache name
 *                      (`scripts/build-sw.ts`), so a new one is a new cache.
 *                      0.92 MB, fetched the first time a character sheet opens.
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
 * The cache name carries a hash of the build's own output. This file is a
 * **template**: `scripts/build-sw.ts` writes `public/sw.js` and `dist/sw.js`
 * from it *after* `vite build`, substituting a content hash over Vite's build
 * manifest **and** the bytes of every unhashed file under `public/` that this
 * worker serves. That is what makes `activate` — which deletes every cache that
 * is not the current one — collect the *previous* build's hashed chunks instead
 * of leaving them to accumulate deploy after deploy. A hand-bumped literal
 * purged only when somebody remembered to change it, which on a routine build
 * is never; `.next/BUILD_ID` changed on every build, so it purged even when
 * nothing had changed.
 *
 * Editing the served worker means editing this file; `public/sw.js` is
 * generated and gitignored, and a hand edit to it is overwritten by the next
 * build.
 */

const VERSION = '__TANGRAM_BUILD_ID__';
const CACHE = `tangram-${VERSION}`;

/** Served for a navigation we have never cached while the network is down. */
const OFFLINE_URL = '/offline.html';

/**
 * The app shell: one document, the offline page, and this build's entry chunk
 * and stylesheet, substituted from Vite's build manifest.
 *
 * It was the seven nav routes. Under the SPA fallback there is only ever **one**
 * document, so those seven precached seven copies of it — and precaching a
 * document without the assets it references is what made an offline navigation
 * render blank through the whole of W1. The list is generated, so `core.md`
 * C7's collapse to three tabs costs this file nothing.
 */
const SHELL = __TANGRAM_PRECACHE__;

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
 * The shell: the network decides, the cache catches.
 *
 * Offline (or on a network error) the last good copy of this exact route is
 * served, then the **app document**, then `/offline.html`.
 *
 * That middle step is new in W3 and it is the reason an offline navigation to a
 * never-visited route now renders the app rather than an apology. Under Next
 * each route had its own HTML, so serving one route's document under another's
 * URL would have been a lie — the old comment here said exactly that, and it
 * was right at the time. Under the SPA fallback there is one document for every
 * path, which is what `/` is precached as, and handing it to `/stats` is
 * precisely what the host itself does. The router then matches the real URL
 * client-side.
 *
 * `/offline.html` stays behind it for the case the document never got cached.
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
    const document = await cache.match('/');
    if (document) return document;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Cross-origin is never this cache's business, and from W4 the API base is a
  // different origin — so this line, not the `/api/` one below, is what keeps a
  // paid, profile-dependent answer out of an HTTP cache once it moves.
  if (url.origin !== self.location.origin) return;

  // Never the API, and never the worker or the manifest themselves.
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;

  // The dictionary is imported into OPFS and must never also sit in the HTTP
  // cache — that is the same 43 MB (or 17 MB brotli) twice, on an origin the
  // browser is already willing to evict wholesale. An explicit deny, agreed
  // with `data.md`, rather than a happy accident of the rules below.
  if (/^\/dict-.+\.sqlite(\.br)?$/.test(url.pathname)) return;

  // `/assets/` is where Vite emits its hashed output. It was `/_next/static/`
  // until web.md W1 swapped the build, and the rule then matched nothing: no
  // script or stylesheet entered the cache, so an offline navigation served a
  // precached document referencing assets that were not there — a blank page
  // where there used to be a working shell. Nothing failed; the worker simply
  // stopped doing its job. The property the rule depends on is unchanged:
  // Vite's names are content-addressed, so a hit is never stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event));
    return;
  }

  // `/decomp.json` is the one file worth caching that the prefix above cannot
  // match: it is copied verbatim out of `public/` and so carries no content
  // hash. Cache-first is safe anyway because its bytes are an input to this
  // cache's NAME (`scripts/build-sw.ts`), so a new decomposition file is a new
  // cache and the old one is dropped on activate. Character decomposition is
  // LGPL and stays its own file — never merged into the dictionary (CLAUDE.md).
  if (url.pathname === '/decomp.json') {
    event.respondWith(cacheFirst(event));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(shell(event));
  }
});
