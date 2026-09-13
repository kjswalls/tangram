/**
 * The route table is the single source of truth, and this is what keeps it one.
 *
 * The failure being guarded is the one `lib/server/route-inventory.ts` was
 * written for and that `web.md` W0's review hit again: a route exists, every
 * local check is green, and nothing exercises it. Here that becomes three
 * assertions — every declared route is mounted, every mounted route is
 * declared, and every declared route has a smoke case.
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { gatedPaths, HTTP_METHODS, ROUTES } from '../src/routes/table.ts';

const app = buildApp();

/** Every path Hono actually registered a non-catch-all handler for. */
function mountedPaths(): Set<string> {
  return new Set(app.routes.map((route) => route.path));
}

describe('routes/table.ts', () => {
  it('mounts exactly the paths it declares', () => {
    expect([...mountedPaths()].sort()).toEqual(ROUTES.map((route) => route.path).sort());
  });

  it('registers every method each route declares', () => {
    for (const route of ROUTES) {
      const registered = app.routes
        .filter((r) => r.path === route.path)
        .map((r) => r.method.toUpperCase());
      for (const method of route.methods) expect(registered, route.path).toContain(method);
    }
  });

  it('gives every declared route at least one smoke case', () => {
    for (const route of ROUTES) {
      expect(route.smoke.length, `${route.path} has no smoke case`).toBeGreaterThan(0);
      for (const testCase of route.smoke) {
        expect(route.methods, `${route.path} smokes a method it does not answer`).toContain(
          testCase.method,
        );
        expect(HTTP_METHODS).toContain(testCase.method);
      }
    }
  });

  it('declares no duplicate paths', () => {
    const paths = ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('hosts none of the five dictionary routes — data.md D6 deletes them, they do not move here', () => {
    for (const path of ['/api/dict/entries', '/api/dict/hsk', '/api/dict/search', '/api/dict/segment', '/api/dict/decomp']) {
      expect(ROUTES.map((r) => r.path)).not.toContain(path);
    }
  });

  it('has no gated route yet, because B1 has not moved the three model routes here', () => {
    // When B1 lands this becomes ['/api/ask', '/api/examples', '/api/recall'].
    // Until then a gated path with no gate in front of it would be the worst of
    // both: a claim of protection and none.
    expect(gatedPaths()).toEqual([]);
  });

  it('throws at boot if the table names a path app.ts has no handler for', () => {
    expect(() =>
      buildApp({
        routes: [{ path: '/nope', methods: ['GET'], gated: false, smoke: [{ method: 'GET', expect: 200 }] }],
      }),
    ).toThrow(/no handler/);
  });

});
