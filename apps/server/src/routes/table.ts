/**
 * Every route this server declares, in one place.
 *
 * docs/plans/backend.md B1 asks for a smoke check "derived from a route table
 * module rather than a hand-written list, so a route added without a smoke case
 * is a test failure". This is that module, and it is introduced in B0 rather
 * than B1 because B0's deliverable is *a deploy procedure that is repeatable*,
 * and the thing that proves a deploy is `pnpm -F server smoke` against it.
 *
 * The table is not documentation: `app.ts` mounts from it, `smoke.ts` walks it,
 * and `tests/routes.test.ts` asserts that the set of paths Hono actually
 * registered equals the set of paths here. So the three cannot drift — a route
 * added to `app.ts` and not here fails the test, and a route added here with no
 * smoke case does not typecheck.
 *
 * The five `/api/dict/*` routes are deliberately **not** here and never will be:
 * `data.md` D6 deletes them and `backend.md` B1 requires that asking this server
 * for one is a 404 rather than a 401, because a gate that quietly widened is a
 * broken PWA.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** How `pnpm -F server smoke` exercises one route. */
export interface SmokeCase {
  method: HttpMethod;
  /** JSON body for a POST. Absent means no body. */
  body?: unknown;
  /**
   * The status that counts as healthy. `pnpm smoke` fails on anything else, so
   * this is where a route that is *supposed* to answer 401 without a credential
   * records that — rather than the smoke quietly accepting any 2xx-or-4xx.
   */
  expect: number;
}

export interface ServerRoute {
  /** The URL path, exactly as it is mounted. */
  path: string;
  /** The methods the handler answers, excluding the OPTIONS preflight. */
  methods: HttpMethod[];
  /**
   * Does this route reach a paid model? The three that do are gated by
   * `TANGRAM_ACCESS_SECRET` (B1). Nothing is gated yet — the model routes do
   * not live here until B1 can run — and the field exists so that adding one
   * without answering the question is impossible.
   */
  gated: boolean;
  /** One smoke case per method the smoke should exercise. */
  smoke: SmokeCase[];
}

export const ROUTES: readonly ServerRoute[] = [
  {
    path: '/health',
    methods: ['GET'],
    gated: false,
    smoke: [{ method: 'GET', expect: 200 }],
  },
];

export function routeByPath(path: string): ServerRoute | undefined {
  return ROUTES.find((route) => route.path === path);
}

/** The paths that cost money, for the gate. Empty until B1 lands the handlers. */
export function gatedPaths(): string[] {
  return ROUTES.filter((route) => route.gated).map((route) => route.path);
}
