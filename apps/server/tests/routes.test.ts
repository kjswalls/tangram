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

import { GATED_PATHS } from '@tangram/access';

import { buildApp } from '../src/app.ts';
import { gatedPaths, HTTP_METHODS, ROUTES } from '../src/routes/table.ts';

const app = buildApp();

/**
 * Every path Hono actually registered a handler for.
 *
 * `'/*'` is excluded — Hono's normalisation of the `'*'` those registrations
 * were written with. `backend.md` B1 put two `app.use('*', …)` middlewares in
 * front of everything (CORS, then the gate) and Hono records them in
 * `app.routes` like any other registration. They are not routes, and counting
 * them would make the two assertions below compare a table of paths against a
 * set that always has one extra member in it.
 */
function mountedPaths(): Set<string> {
  return new Set(app.routes.map((route) => route.path).filter((path) => path !== '/*'));
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

  it('gates exactly the three paths the access package gates, in both directions', () => {
    // The two lists are written by different plans — `GATED_PATHS` is
    // `web.md` W4's in `packages/access`, this table is `backend.md` B1's — and
    // a disagreement either way is a bill. A path the gate covers and the table
    // calls open is a route answering for free; a path the table calls gated
    // and the gate does not cover is a claim of protection and none.
    expect(gatedPaths().sort()).toEqual([...GATED_PATHS].sort());
  });

  it('declares GET only where a handler answers GET', () => {
    // `/api/recall` has no handshake and must not advertise one: a GET to it is
    // a 405 with `Allow: POST`, not a 200 the client would try to read a
    // provider name out of.
    const recall = ROUTES.find((route) => route.path === '/api/recall');
    expect(recall?.methods).toEqual(['POST']);
  });

  it('throws at boot if the table names a path app.ts has no handler for', () => {
    expect(() =>
      buildApp({
        routes: [{ path: '/nope', methods: ['GET'], gated: false, smoke: [{ method: 'GET', expect: 200 }] }],
      }),
    ).toThrow(/no handler/);
  });

  it('throws at boot if the table declares a METHOD app.ts has no handler for', () => {
    // The dimension B1 added. Until B1 every route answered one verb, so "the
    // path is mounted" was the whole question; `/api/ask` and `/api/examples`
    // answer two each. A table that declared `DELETE /api/ask` would otherwise
    // register a handler-less verb and 404 in the deployment.
    expect(() =>
      buildApp({
        routes: ROUTES.map((route) =>
          route.path === '/api/recall' ? { ...route, methods: ['POST', 'DELETE' as const] } : route,
        ),
      }),
    ).toThrow(/no handler for that method/);
  });

  it('throws at boot if app.ts answers a METHOD the table does not declare', () => {
    expect(() =>
      buildApp({
        routes: ROUTES.map((route) =>
          route.path === '/api/ask' ? { ...route, methods: ['POST' as const] } : route,
        ),
      }),
    ).toThrow(/does not declare that method/);
  });

  it('throws at boot if app.ts has a handler the table does not declare', () => {
    // The direction B1 will actually hit, because B1 adds handlers. Unguarded,
    // the route is never mounted, mountedPaths() is derived from the table so
    // this file cannot see it, smoke.ts walks the table so the smoke never
    // probes it — and POST /api/ask 404s in the deployment with every gate
    // green. Passing an empty table makes app.ts's own '/health' the orphan.
    expect(() => buildApp({ routes: [] })).toThrow(/does not declare it/);
  });

});
