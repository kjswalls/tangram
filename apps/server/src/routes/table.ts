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

import { RETRIEVED_CAP } from '@tangram/ai/schemas';

/**
 * A `retrieved` array one row over `RETRIEVED_CAP`, for the smoke.
 *
 * **This is what replaced `backend.md` B1's seventh smoke case, and the
 * replacement is a demotion on purpose.** B1's extra case sent a well-formed
 * body naming an entry id no dictionary contains: it got past validation,
 * opened the 43 MB artifact, and answered 404 — so a deployment that had
 * shipped the code without the data answered 503 there and the smoke failed
 * naming the line. `backend.md` B2 removes that hazard at its root rather than
 * detecting it: **this server has no dictionary**, so a dictionary-less server
 * is now the correct one and there is nothing left for that case to catch.
 *
 * What is left worth proving is that the **edge validator** runs, not merely
 * that the route is mounted. An empty `{}` is refused by the first field it
 * looks at; this body is well formed all the way down and is refused by the one
 * rule that exists for cost control. Both answer 400, so the smoke cannot tell
 * them apart by status — which is the honest limit of an after-deploy check
 * that must never reach a paid provider, and is recorded as such in
 * `HANDOFF.md`.
 */
const OVER_CAP_RETRIEVED = Array.from({ length: RETRIEVED_CAP + 1 }, (_unused, index) => ({
  id: `smoke|smoke[smoke${index}]`,
  simp: 'X',
  trad: 'X',
  pinyinMarked: 'X',
  glosses: [],
}));

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
   * The ask endpoints, as `backend.md` B2's contract flip leaves them
   * (`packages/ai/schemas.ts`, the frozen paths). `/api/ask` is the handshake
   * and answers **GET only** now: the single `POST /api/ask` became two calls,
   * because the model's phrase proposals are an input to a retrieval step that
   * happens in the browser.
   *
   * Both new paths sit **under** `/api/ask`, which is why the gate matches by
   * prefix (`wave-zero.md` §10a) — an exact-string gate would leave the two
   * routes that actually spend money open while `TANGRAM_ACCESS_SECRET` is set.
   * `gated: true` on each is the other half of that, and `tests/routes.test.ts`
   * checks this column against `GATED_PATHS` in both directions.
   *
   * **The POST cases send a body the route rejects, on purpose.** A smoke run is
   * an after-deploy habit (`docs/deploy.md`) and these routes cost money on
   * every successful call, so a case that answered 200 would bill the owner
   * every time anyone checked a deploy. 400 is therefore the healthy status,
   * and `expect` exists on `SmokeCase` precisely so a route whose healthy answer
   * is not a 2xx can say so rather than have the smoke quietly accept any 4xx.
   *
   * With `--gate on` each of these runs twice: unkeyed expecting 401, keyed
   * expecting the status below. That pair is B1's first acceptance criterion and
   * it now covers five paths rather than three.
   */
  {
    path: '/api/ask',
    methods: ['GET'],
    gated: true,
    smoke: [{ method: 'GET', expect: 200 }],
  },
  {
    path: '/api/ask/propose',
    methods: ['POST'],
    gated: true,
    smoke: [{ method: 'POST', body: {}, expect: 400 }],
  },
  {
    path: '/api/ask/answer',
    methods: ['POST'],
    gated: true,
    smoke: [
      { method: 'POST', body: {}, expect: 400 },
      {
        // Well formed all the way down, and over the one cap that exists for
        // cost control. See `OVER_CAP_RETRIEVED`.
        method: 'POST',
        body: {
          query: 'smoke',
          profile: { estimatedBand: 1, knownSample: [] },
          retrieved: OVER_CAP_RETRIEVED,
        },
        expect: 400,
      },
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
