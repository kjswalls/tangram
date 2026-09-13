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

import { NAV_ITEMS } from '@/components/shell/nav';

const root = appRoot(import.meta.dirname);
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'));
// `scripts/` is at the WORKSPACE root, not the app's (docs/plans/wave-zero.md §1).
const sw = readFileSync(resolve(workspaceRoot(import.meta.dirname), 'scripts/sw.template.js'), 'utf8');
// The entry document carries what Next's `metadata`/`viewport` exports emitted.
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

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

  it('bails out of every /api request before it can respond', () => {
    // The guard has to `return` — an /api path that reaches respondWith is a
    // second, dumber cache in front of a grounded, profile-dependent answer.
    expect(sw).toMatch(/if \(url\.pathname\.startsWith\('\/api\/'\)\) return;/);
    const apiIndex = sw.indexOf("startsWith('/api/')");
    const staticIndex = sw.indexOf("startsWith('/_next/static/')");
    expect(apiIndex).toBeGreaterThan(-1);
    expect(staticIndex).toBeGreaterThan(apiIndex);
  });

  it('caches the hashed static chunks and precaches every nav route', () => {
    expect(sw).toContain('cacheFirst(event)');
    // Read off the nav rather than listed here: `/stats` arrived in Phase 8 and
    // a hand-copied list is how a nav destination quietly stops being offline.
    for (const item of NAV_ITEMS) {
      expect(sw).toContain(`'${item.href}'`);
    }
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
    // Precached, or the fallback is a 503 the first time it is needed.
    expect(sw).toMatch(/const SHELL = \[[^\]]*OFFLINE_URL/);
    // The old fallback served the cached home page under the requested URL.
    expect(sw).not.toContain("cache.match('/')");
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
