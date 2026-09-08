/**
 * Two things a route can forget, both of which only fail in production.
 *
 *  1. **`outputFileTracingIncludes`.** Vercel traces and bundles every route
 *     separately, so a route that reads `data/dict.json` and is not listed in
 *     `next.config.ts` works under `next dev` and under `pnpm start` — the file
 *     is on disk in both — and 500s in the deployment, on that route alone.
 *     `/api/examples` and `/api/recall` shipped exactly that way and were found
 *     by hand.
 *  2. **A route nobody exercises.** `pnpm smoke` is only as good as its case
 *     list, so a new route with no case has to fail *here*, cheaply, rather
 *     than being silently skipped by the thing that was supposed to catch (1).
 *
 * Both are answered from the import graph and the config, not from memory.
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import nextConfig from '@/next.config';
import {
  discoverApiRoutes,
  readsDictionary,
  tracingKeyMatches,
  untracedDictRoutes,
} from '@/lib/server/route-inventory';
import { checkRouteCoverage, PAGE_CASES, SMOKE_CASES } from '@/scripts/smoke';

const ROOT = resolve(__dirname, '../../..');

describe('the route inventory', () => {
  const routes = discoverApiRoutes(ROOT);

  it('finds every API route, and each one exports a handler', () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
    expect(routes.map((route) => route.path)).toEqual(
      expect.arrayContaining([
        '/api/ask',
        '/api/dict/decomp',
        '/api/dict/entries',
        '/api/dict/hsk',
        '/api/dict/search',
        '/api/dict/segment',
        '/api/examples',
        '/api/recall',
      ]),
    );
    for (const route of routes) {
      expect(route.methods, route.relativeFile).not.toHaveLength(0);
    }
  });

  it('knows which routes reach the dictionary loader', () => {
    const reading = routes.filter((route) => readsDictionary(route, ROOT)).map((r) => r.path);
    // Every route in this app reads it except none — stated as a set rather
    // than a count so that adding a route that does *not* read it is also a
    // deliberate edit here.
    expect(reading).toEqual(
      expect.arrayContaining(['/api/ask', '/api/dict/search', '/api/examples', '/api/recall']),
    );
  });
});

describe('tracing coverage', () => {
  it('ships data/ to every route that reads it', () => {
    const includes = nextConfig.outputFileTracingIncludes ?? {};
    const untraced = untracedDictRoutes(discoverApiRoutes(ROOT), includes, ROOT);
    expect(
      untraced.map((route) => route.path),
      'add an outputFileTracingIncludes entry in next.config.ts for these',
    ).toEqual([]);
  });

  it('matches keys the way Next does, `**` included', () => {
    expect(tracingKeyMatches('/api/dict/**', '/api/dict/search')).toBe(true);
    // `**` also matches nothing, which is why `/api/ask/**` covers `/api/ask`.
    expect(tracingKeyMatches('/api/ask/**', '/api/ask')).toBe(true);
    expect(tracingKeyMatches('/api/ask/**', '/api/asking')).toBe(false);
    expect(tracingKeyMatches('/api/dict/**', '/api/ask')).toBe(false);
    expect(tracingKeyMatches('/api/recall', '/api/recall')).toBe(true);
  });
});

describe('smoke coverage', () => {
  it('has a case for every handler in app/api', () => {
    expect(checkRouteCoverage(ROOT), 'add a case to SMOKE_CASES in scripts/smoke.ts').toEqual([]);
  });

  it('also walks the six nav routes and the three files the PWA needs', () => {
    const paths = PAGE_CASES.map((c) => c.url({}));
    expect(paths).toEqual(
      expect.arrayContaining(['/', '/lookup', '/review', '/read', '/lists', '/settings']),
    );
    expect(paths).toEqual(
      expect.arrayContaining(['/sw.js', '/manifest.webmanifest', '/offline.html']),
    );
  });

  it('names a real route for every API case, so coverage cannot be faked', () => {
    const known = new Set(discoverApiRoutes(ROOT).map((route) => route.path));
    for (const smokeCase of SMOKE_CASES) {
      expect(smokeCase.route, smokeCase.name).not.toBeNull();
      expect(known.has(smokeCase.route as string), `${smokeCase.name} → ${smokeCase.route}`).toBe(
        true,
      );
    }
  });
});
