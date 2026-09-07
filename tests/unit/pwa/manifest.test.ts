/**
 * The PWA shell (PLAN.md §3.6).
 *
 * The manifest and the worker are hand-written static files, so nothing else
 * type-checks them. These assertions are the type check: the fields a browser
 * refuses to install without, an icon that actually exists on disk, and the
 * three cache rules that make the worker safe (skipWaiting/claim, a versioned
 * cache name, and no route under /api ever entering it).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'));
const sw = readFileSync(resolve(root, 'public/sw.js'), 'utf8');

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

  it('is linked from the root layout', () => {
    const layout = readFileSync(resolve(root, 'app/layout.tsx'), 'utf8');
    expect(layout).toContain("manifest: '/manifest.webmanifest'");
  });
});

describe('sw.js', () => {
  it('takes over immediately and versions its cache', () => {
    expect(sw).toContain('skipWaiting');
    expect(sw).toContain('clients.claim');
    expect(sw).toMatch(/const VERSION = '[^']+'/);
    expect(sw).toMatch(/const CACHE = `tangram-\$\{VERSION\}`/);
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

  it('caches the hashed static chunks and precaches the six shell routes', () => {
    expect(sw).toContain('cacheFirst(request)');
    for (const route of ['/', '/lookup', '/review', '/read', '/lists', '/settings']) {
      expect(sw).toContain(`'${route}'`);
    }
  });

  it('only ever stores a same-origin, ok response', () => {
    const puts = sw.match(/cache\.put\(/g) ?? [];
    expect(puts.length).toBeGreaterThan(0);
    const guards = sw.match(/response\.ok && response\.type === 'basic'/g) ?? [];
    // The install precache guards on `response.ok` alone (it fetched the URL itself).
    expect(guards.length).toBe(puts.length - 1);
  });
});
