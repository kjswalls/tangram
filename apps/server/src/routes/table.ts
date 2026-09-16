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
   * `TANGRAM_ACCESS_SECRET`. The field exists so that adding a route without
   * answering the question is impossible — and `tests/routes.test.ts` checks
   * this column against `GATED_PATHS` in `@tangram/access`, in both directions,
   * so a path the gate covers and the table calls open (or the reverse) is a
   * failing test rather than an invoice.
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
  /**
   * The three model routes (`backend.md` B1), at the paths they have always
   * had. The paths are preserved verbatim because `GATED_PATHS` in
   * `@tangram/access` names them literally and B0 settled that they stay that
   * way.
   *
   * **The POST cases send a body the route rejects, on purpose.** A smoke run
   * is an after-deploy habit (`docs/deploy.md`) and these three routes cost
   * money on every successful call, so a case that answered 200 would bill the
   * owner every time anyone checked a deploy. An empty object exercises
   * everything this file is for — the route is mounted, the method is
   * routed, the gate ran, the handler parsed — and stops one step short of the
   * provider. 400 is therefore the healthy status, and `expect` exists on
   * `SmokeCase` precisely so a route whose healthy answer is not a 2xx can say
   * so rather than have the smoke quietly accept any 4xx.
   *
   * With `--gate on` each of these runs twice: unkeyed expecting 401, keyed
   * expecting the status below. That pair is B1's first acceptance criterion.
   */
  {
    path: '/api/ask',
    methods: ['GET', 'POST'],
    gated: true,
    smoke: [
      { method: 'GET', expect: 200 },
      { method: 'POST', body: {}, expect: 400 },
    ],
  },
  {
    path: '/api/examples',
    methods: ['GET', 'POST'],
    gated: true,
    smoke: [
      { method: 'GET', expect: 200 },
      { method: 'POST', body: {}, expect: 400 },
    ],
  },
  {
    path: '/api/recall',
    methods: ['POST'],
    gated: true,
    smoke: [{ method: 'POST', body: {}, expect: 400 }],
  },
];

export function routeByPath(path: string): ServerRoute | undefined {
  return ROUTES.find((route) => route.path === path);
}

/** The paths that cost money, for the gate. */
export function gatedPaths(): string[] {
  return ROUTES.filter((route) => route.gated).map((route) => route.path);
}
