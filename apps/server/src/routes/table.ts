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

/**
 * An entry id shaped like a real one and belonging to no dictionary build.
 *
 * `trad|simp[pinyin]` is the shape (PLAN.md §3.1). It has to parse far enough
 * to be looked up and it must never resolve, on any CC-CEDICT snapshot — so it
 * is deliberately not a rare word that might one day be added, but a string no
 * lexicographer will ever produce.
 */
export const NO_SUCH_ENTRY_ID = 'smoke-no-such-entry|smoke-no-such-entry[nothing]';

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
   * **`/api/examples` gets a second case, and it is the one that proves there
   * is a dictionary.** An adversarial reviewer ran the smoke against a deploy
   * artifact with no `data/` and got a perfect 6/6 while every real request
   * answered `{"error":"dict-data-missing"}` — because `parseBody` rejects `{}`
   * *before* `serverDictStore()` is reached, and both handshakes are pure. So
   * one case sends a well-formed body naming an entry id no dictionary
   * contains: it gets past validation, opens the artifact, looks the id up, and
   * answers **404 `entry-not-found`** — still without going near a provider. A
   * server with no dictionary answers 503 there and the smoke fails, which is
   * the whole point. `backend.md` B1 keeps the dictionary on this server "on
   * purpose and temporarily"; until B2 removes it, this is what says it is
   * actually present.
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
      {
        method: 'POST',
        body: { entryId: NO_SUCH_ENTRY_ID, profile: { estimatedBand: 1, knownSample: [] } },
        expect: 404,
      },
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
