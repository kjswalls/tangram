/**
 * The PWA shell (PLAN.md §3.6).
 *
 * The manifest and the worker are hand-written static files, so nothing else
 * type-checks them. These assertions are the type check: the fields a browser
 * refuses to install without, an icon that actually exists on disk, and the
 * cache rules that make the worker safe (skipWaiting/claim, a cache name bound
 * to the build, no route under /api ever entering it, and navigations that ask
 * the network first so a deploy cannot serve the previous build's HTML).
 *
 * The worker read here is `scripts/sw.template.js`, the committed source.
 * `public/sw.js` is generated from it at build time (`scripts/build-sw.ts`) and
 * is gitignored, so it is absent in a fresh clone; what the generator does with
 * the template is pinned in `build-sw.test.ts` beside this file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appRoot, workspaceRoot } from '@/lib/server/roots';
import { precacheList } from '../../../../../scripts/build-sw';

import { TABS, TAB_PATHS } from '@/components/shell/nav';

const root = appRoot(import.meta.dirname);
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'));
// `scripts/` is at the WORKSPACE root, not the app's (docs/plans/wave-zero.md §1).
const sw = readFileSync(resolve(workspaceRoot(import.meta.dirname), 'scripts/sw.template.js'), 'utf8');
// The entry document carries what Next's `metadata`/`viewport` exports emitted.
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

/**
 * Where the build puts its hashed output. Vite's default is `assets/` under
 * `build.outDir`; `build.assetsDir` overrides it. Read from the config rather
 * than written down twice, because the service worker's cache-first rule keys
 * on this exact prefix and the two silently diverging is what W1 shipped.
 */
const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
const assetsDir = /assetsDir:\s*'([^']+)'/.exec(viteConfig)?.[1] ?? 'assets';
const ASSET_DIR = `/${assetsDir}/`;

describe('manifest.webmanifest', () => {
  it('carries the fields an install prompt requires', () => {
    expect(manifest.name).toBe('Tangram');
    expect(manifest.short_name).toBe('Tangram');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('describes itself in the app’s own words, in both places at once', () => {
    /**
     * The tagline is written twice — once in the manifest, once as the entry
     * document's `<meta name="description">` — and the installed app shows the
     * manifest's copy. C8 renamed the verb everywhere a learner can see it and
     * both copies kept saying "review it", because neither is in a directory
     * the jargon sweep walked and nothing held them to each other. Found by
     * C8's adversarial review.
     */
    const meta = /<meta name="description" content="([^"]+)"/.exec(html)?.[1];
    expect(meta).toBeDefined();
    expect(manifest.description).toBe(meta);
    // The one word C8 replaced. Not a general jargon sweep — that lives in the
    // components — just the tagline the home screen quotes back.
    expect(manifest.description).not.toMatch(/\breviews?\b/i);
    expect(manifest.description).toMatch(/practise/i);
  });

  it('leaves orientation to the device', () => {
    // Locking portrait forces an installed tablet out of the wide reader layout.
    expect(manifest.orientation).toBeUndefined();
  });

  it('ships a raster icon for the platforms that refuse SVG', () => {
    // iOS ignores the manifest for the home-screen tile and takes a screenshot
    // without an apple-touch-icon. Next emitted the link from the
    // app/apple-icon.png file convention; index.html carries it now, so the
    // assertion reads the document rather than the convention — and checks the
    // file it points at is really on disk, which the convention never did.
    const appleIcon = /<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/.exec(html);
    expect(appleIcon, 'index.html must link an apple-touch-icon').not.toBeNull();
    expect(existsSync(resolve(root, 'public', appleIcon![1].replace(/^\//, '')))).toBe(true);
    const png = manifest.icons.filter((icon: { type?: string }) => icon.type === 'image/png');
    expect(png.map((icon: { sizes: string }) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
  });

  it('points at icons that are on disk, one of them maskable', () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(true);
      expect(existsSync(resolve(root, 'public', icon.src.replace(/^\//, '')))).toBe(true);
    }
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable')).toBe(
      true,
    );
  });

  it('is linked from the entry document', () => {
    // Next emitted this from `metadata.manifest` in app/layout.tsx. There is no
    // metadata source now; index.html is the document that carries it.
    expect(html).toMatch(/<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/);
  });

  it('declares viewport-fit=cover, without which every safe-area inset is zero', () => {
    // ios.md I5's safe-area work and android.md A2's inset work both build
    // against a constant without it (docs/plans/wave-zero.md §10, ruling 12).
    // One attribute, two blocked mobile phases, so it is asserted not remembered.
    const viewport = /<meta[^>]+name="viewport"[^>]+content="([^"]+)"/.exec(html);
    expect(viewport, 'index.html must have a viewport meta').not.toBeNull();
    expect(viewport![1]).toContain('viewport-fit=cover');
  });

  it('declares lang="zh-Hans" on the document', () => {
    // Han unification: a device in a Japanese locale renders Japanese glyph
    // forms for the same code points without it, and a Chromium WebView
    // regression stopped synthesising bold for CJK (STACK §2.1, core.md C0 r2).
    expect(html).toMatch(/<html[^>]+lang="zh-Hans"/);
  });
});

describe('sw.js', () => {
  it('takes over immediately and names its cache after the build', () => {
    expect(sw).toContain('skipWaiting');
    expect(sw).toContain('clients.claim');
    // The version is a placeholder in the template and a build id in the file
    // the browser gets, which is what makes `activate` purge the last build's
    // chunks instead of keeping every deploy's forever.
    expect(sw).toContain("const VERSION = '__TANGRAM_BUILD_ID__'");
    expect(sw).toMatch(/const CACHE = `tangram-\$\{VERSION\}`/);
    // `activate` drops every other cache; with a per-build name, that is the purge.
    expect(sw).toMatch(/names\.filter\(\(name\) => name !== CACHE\)/);
  });

  it('returns before `respondWith` for anything cross-origin', () => {
    // From `web.md` W4 the API base is another origin, so this line — not the
    // `/api/` one below — is what keeps a paid, profile-dependent answer out of
    // an HTTP cache. `tests/e2e/c/sw-version.spec.ts` exercises it against a
    // real second origin on the one path the worker would otherwise cache.
    expect(sw).toContain('if (url.origin !== self.location.origin) return;');
    const bail = sw.indexOf('if (url.origin !== self.location.origin) return;');
    expect(bail).toBeLessThan(sw.indexOf(`startsWith('${ASSET_DIR}')`));
  });

  it('bails out of every /api request before it can respond', () => {
    // The guard has to `return` — an /api path that reaches respondWith is a
    // second, dumber cache in front of a grounded, profile-dependent answer.
    expect(sw).toMatch(/if \(url\.pathname\.startsWith\('\/api\/'\)\) return;/);
    const apiIndex = sw.indexOf("startsWith('/api/')");
    const staticIndex = sw.indexOf(`startsWith('${ASSET_DIR}')`);
    expect(apiIndex).toBeGreaterThan(-1);
    expect(staticIndex).toBeGreaterThan(apiIndex);
  });

  it('caches the hashed static chunks', () => {
    expect(sw).toContain('cacheFirst(event)');
    // Not a literal: the rule has to name the directory THIS BUILD emits. It
    // said '/_next/static/' through the whole of W1 and matched nothing, so the
    // worker cached no script or stylesheet at all and an offline navigation
    // rendered a blank page. Every gate stayed green. Read the prefix off the
    // build config so the two cannot drift again.
    expect(sw).toContain(`url.pathname.startsWith('${ASSET_DIR}')`);
  });

  it('precaches a GENERATED list, not the nav — there is one document now', () => {
    // W3. The list was the seven nav routes; under the SPA fallback those are
    // seven copies of one document, and precaching a document without the
    // assets it references is what made an offline navigation render blank.
    // `scripts/build-sw.ts` substitutes `/`, `/offline.html` and this build's
    // entry chunk and stylesheet, read out of Vite's manifest — so `core.md`
    // C7's collapse to three tabs costs this file nothing, and no nav route is
    // named here to go stale.
    expect(sw).toContain('const SHELL = __TANGRAM_PRECACHE__');
    for (const tab of TABS) {
      if (tab.path === '/') continue;
      expect(sw, `${tab.path} must not be a literal in the worker any more`).not.toContain(
        `'${tab.path}'`,
      );
    }
  });

  it('denies the dictionary artifact outright, brotli sibling included', () => {
    // It is imported into OPFS (`data.md` D4); an HTTP-cache copy is the same
    // 43 MB again on an origin the browser is willing to evict wholesale.
    const rule = 'if (/^\\/dict-.+\\.sqlite(\\.br)?$/.test(url.pathname)) return;';
    expect(sw).toContain(rule);
    // Anchored on the RULE, not on the first `.sqlite` in the file — which is
    // in the header comment on line 20, so the old version of this assertion
    // compared a prose position against a code position and was true wherever
    // the real rule sat.
    const deny = sw.indexOf(rule);
    const assets = sw.indexOf(`startsWith('${ASSET_DIR}')`);
    expect(deny).toBeGreaterThan(-1);
    // Before the cache-first rules, so nothing can reach `respondWith` first.
    expect(deny).toBeLessThan(assets);
  });

  it('gives /decomp.json the one runtime rule the asset prefix cannot cover', () => {
    // It is copied verbatim out of `public/`, so it carries no content hash and
    // `/assets/` does not match it. Cache-first is safe only because its bytes
    // are an input to the cache's NAME (`scripts/build-sw.ts`).
    expect(sw).toContain("url.pathname === '/decomp.json'");
  });

  it('answers a navigation from the network first, cache second', () => {
    // Cache-first here is the bug: a document cached before a deploy points at
    // chunk hashes the new deployment does not serve, and VERSION is bumped by
    // hand, so the first load of every route after every deploy never hydrates.
    const body = sw.slice(sw.indexOf('async function shell('), sw.indexOf('addEventListener(\'fetch'));
    const fetched = body.indexOf('await fetch(request)');
    const matched = body.indexOf('cache.match(request');
    expect(fetched).toBeGreaterThan(-1);
    expect(matched).toBeGreaterThan(fetched);
    // …and the cache read is only reachable from the failure path.
    expect(body.indexOf('} catch {')).toBeLessThan(matched);
  });

  it('falls back to an offline page, never to another route under this URL', () => {
    expect(existsSync(resolve(root, 'public/offline.html'))).toBe(true);
    expect(sw).toContain("const OFFLINE_URL = '/offline.html'");
    expect(sw).toContain('cache.match(OFFLINE_URL)');
    // Precached, or the fallback is a 503 the first time it is needed. The
    // list is generated now, so the assertion is on the generator's output.
    expect(precacheList('/nonexistent/dist')).toContain('/offline.html');
    // W3 REVERSES one earlier rule. Under Next each route had its own HTML, so
    // serving one route's document under another's URL would have been a lie.
    // Under the SPA fallback there is one document for every path — handing it
    // to a never-visited route offline is exactly what the host does, and it is
    // the difference between the app rendering and an apology rendering.
    const body = sw.slice(sw.indexOf('async function shell('), sw.indexOf("addEventListener('fetch"));
    expect(body).toContain("cache.match('/')");
    expect(body.indexOf("cache.match('/')")).toBeLessThan(body.indexOf('cache.match(OFFLINE_URL)'));
  });

  /**
   * The offline page may only link where the offline page can actually go
   * (found by C7's adversarial review).
   *
   * It shipped for one commit offering `/review`, `/lists` and `/settings` —
   * paths core.md C7 had deleted. Online, the SPA fallback lands the learner on
   * the not-found screen; that half is still the bug and still checked below.
   *
   * **The offline half of C7's reasoning no longer holds, and the check changed
   * with it.** C7 derived the allowed set from the `SHELL` literal, on the
   * grounds that the worker has nothing cached for an unprecached path and
   * serves this same page again. `web.md` W3 landed at the same time and made
   * `SHELL` a build-time substitution of one document plus this build's assets,
   * with `shell()` falling back to `cache.match('/')` for *any* navigation — so
   * every route renders offline from the one cached document, precached or not.
   * The case above asserts that ordering, and `tests/e2e/c/sw-offline.spec.ts`
   * proves it in a browser on a never-visited route. Deriving from `SHELL` here
   * would now compare links against a list of asset URLs.
   *
   * So the set is the tab model, which is what "where the offline page can go"
   * actually means under the fallback, and what the next phase that moves a tab
   * will move.
   */
  it('links only to paths the app still has', () => {
    const page = readFileSync(resolve(root, 'public/offline.html'), 'utf8');
    const reachable = new Set<string>([
      ...Object.values(TAB_PATHS).filter((path) => !path.includes(':')),
      '/offline.html',
    ]);
    const links = [...page.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((href) => !reachable.has(href))).toEqual([]);
    // …and the three it does offer are the three tabs, named as the tabs are.
    expect(links).toEqual(['/', '/practice', '/library']);
    for (const gone of ['/review', '/lists', '/settings', '/today', '/lookup', '/stats']) {
      expect(page, `offline.html still links ${gone}`).not.toContain(`href="${gone}"`);
    }
  });

  it('only ever stores a same-origin, ok response', () => {
    expect(sw).toMatch(
      /function storable\(response\) \{[\s\S]*?response\.ok && response\.type === 'basic'/,
    );
    const puts = sw.match(/cache\.put\(request/g) ?? [];
    const guards = sw.match(/if \(storable\(response\)\)/g) ?? [];
    expect(puts.length).toBeGreaterThan(0);
    expect(guards.length).toBe(puts.length);
  });

  it('holds the worker open for the cache write it does not wait on', () => {
    const waits = sw.match(/event\.waitUntil\(cache\.put\(/g) ?? [];
    expect(waits.length).toBe(2);
  });
});
