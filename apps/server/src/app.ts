/**
 * The Hono application, built from `routes/table.ts` and nothing else.
 *
 * Listening is `index.ts`'s job; this module returns an app whose `fetch` a
 * test can call directly. That split is what lets every route be asserted
 * without a socket, which matters because there is no CI
 * (`docs/plans/wave-zero.md` §10, ruling 13) and every rule that wants
 * enforcement has to be a unit test.
 *
 * **Why Hono** (the B0 decision, recorded in HANDOFF.md): the ten handlers this
 * server will host are already `(request: Request) => Promise<Response>`, so the
 * framework is nearly irrelevant to them — which is precisely the argument for
 * picking the one that keeps B0's own falsifier open. B0 says that if the host's
 * limits clear the 30 s ask deadline *and* `packages/ai/**` runs unmodified on
 * Supabase Edge Functions, the proxy belongs there and this becomes one
 * deployable. Hono runs on Node, Deno, Bun and Workers off the same source;
 * a bare `node:http` server would have to be rewritten to test that.
 *
 * **Two middlewares wrap everything, and their order is the design**
 * (`backend.md` B1):
 *
 *  1. **CORS** appends `Vary: Origin` — and `Access-Control-Allow-Origin` for an
 *     allowed origin — to *every* response, the 401 and the 404 included. That
 *     is not decoration: `apps/app/src/access/client.ts` authorises a phone by
 *     reading the **status** of a probe, and a cross-origin 401 with no
 *     `Access-Control-Allow-Origin` reaches page script as a network error, not
 *     as a 401. The gate would then report "unverified" for a key that is
 *     definitely wrong, and revoke nothing.
 *  2. **The gate** refuses a gated path without `X-Tangram-Access`, by PREFIX
 *     (`wave-zero.md` §10a). It runs *inside* CORS so its 401 carries those
 *     headers, and *before* routing so that a gated path which does not exist
 *     answers 401 rather than 404 — `/api/ask/propose` is `backend.md` B2's and
 *     is already covered by the prefix today.
 *
 * The handlers each call `requireAccess` again as their first line, and that
 * redundancy is deliberate: `packages/access`'s own header says a gate that
 * lives only in a matcher is one config edit from being off, and the failure
 * mode is an invoice.
 */
import { Hono } from 'hono';

import {
  isAuthorizedRequest,
  isGatedPath,
  unauthorizedResponse,
} from '@tangram/access';

import { corsHeaders, preflightHeaders, type CorsPolicy } from './cors.ts';
import type { Env } from './config.ts';
import { redactString, type Logger } from './log.ts';
import * as ask from './routes/ask.ts';
import * as examples from './routes/examples.ts';
import { health } from './routes/health.ts';
import * as recall from './routes/recall.ts';
import { ROUTES, type HttpMethod, type ServerRoute } from './routes/table.ts';

export interface AppOptions {
  startedAt?: number;
  logger?: Logger;
  /** Include the error message in a 500 body. Off in production. */
  exposeErrors?: boolean;
  /**
   * The table to mount. Defaults to `ROUTES` and is overridable only so a test
   * can prove the missing-handler guard below fires — a guard nothing exercises
   * is a guard nobody knows is broken.
   */
  routes?: readonly ServerRoute[];
  /** The cross-origin allowlist. Defaults to nothing but the native origins. */
  cors?: CorsPolicy;
  /**
   * What the gate compares its secret against. Left undefined,
   * `@tangram/access` reads the ambient environment itself, which is what
   * `index.ts` wants; a test passes one in. This module never reads the
   * environment — `tests/config.test.ts` walks `src/` for exactly that, and
   * `index.ts` is the one place a value is taken out of it.
   */
  env?: Env;
}

/**
 * The handler for each declared path, per verb.
 *
 * **The check is symmetric in both dimensions, and three of the four halves
 * exist because of a failure somebody actually shipped.** A table entry with no
 * handler throws at boot — easy, and the rarest direction. A *handler* with no
 * table entry is the one B1 hit, because B1 adds handlers: it is never mounted,
 * `mountedPaths()` is derived from the table so the route test cannot see it,
 * `smoke.ts` walks the table so the smoke never probes it, and every gate stays
 * green while `POST /api/ask` 404s in the deployment. B1 adds the third: a
 * *method* declared with no handler, and a handler for a method the table does
 * not declare. `/api/ask` and `/api/examples` answer two verbs each and
 * `/api/recall` answers one, so "the path is mounted" stopped being the whole
 * question the moment the model routes arrived.
 */
type MethodHandlers = Partial<Record<HttpMethod, (request: Request) => Response | Promise<Response>>>;
type RouteHandlers = Record<string, MethodHandlers>;

export function buildApp(options: AppOptions = {}): Hono {
  const startedAt = options.startedAt ?? Date.now();
  const logger = options.logger;
  const policy = options.cors ?? { origins: new Set<string>() };
  const env = options.env;
  const app = new Hono();

  const handlers: RouteHandlers = {
    '/health': { GET: () => health(startedAt) },
    '/api/ask': { GET: ask.GET, POST: ask.POST },
    '/api/examples': { GET: examples.GET, POST: examples.POST },
    '/api/recall': { POST: recall.POST },
  };

  const table = options.routes ?? ROUTES;

  // 1 — CORS, outermost, so every response below carries `Vary` and (for an
  // allowed origin) `Access-Control-Allow-Origin`. Mutating `c.res.headers`
  // after `next()` is hono/cors's own pattern.
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(corsHeaders(c.req.header('origin') ?? null, policy))) {
      c.res.headers.set(name, value);
    }
  });

  // 2 — the gate. `OPTIONS` is exempt because a preflight is defined to carry
  // no credentials: refusing it would make every cross-origin POST fail before
  // the browser ever sent the header the gate wants.
  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const paths = pathsOf(c.req.url);
    // An unparseable URL is treated as gated: nothing can be proved about it,
    // and the safe answer for the one check whose failure is an invoice is the
    // one that refuses. With no secret configured `isAuthorizedRequest` still
    // says yes, so this cannot break a local run.
    if (paths !== null && !paths.some((path) => isGatedPath(path))) return next();
    const denied = isAuthorizedRequest(c.req.raw, env) ? null : unauthorizedResponse();
    if (denied) return denied;
    return next();
  });

  for (const route of table) {
    const byMethod = handlers[route.path];
    if (!byMethod) {
      throw new Error(`routes/table.ts declares ${route.path} but app.ts has no handler for it`);
    }
    for (const method of route.methods) {
      if (!byMethod[method]) {
        throw new Error(
          `routes/table.ts declares ${method} ${route.path} but app.ts has no handler for that method`,
        );
      }
    }
    for (const method of Object.keys(byMethod) as HttpMethod[]) {
      if (!route.methods.includes(method)) {
        throw new Error(
          `app.ts has a ${method} handler for ${route.path} but routes/table.ts does not declare that method, so it is never mounted`,
        );
      }
    }
    mount(app, route, byMethod, policy);
  }

  const declared = new Set(table.map((route) => route.path));
  for (const path of Object.keys(handlers)) {
    if (!declared.has(path)) {
      throw new Error(
        `app.ts has a handler for ${path} but routes/table.ts does not declare it, so it is never mounted`,
      );
    }
  }

  app.notFound((c) =>
    c.json({ error: 'not-found' }, 404, { 'cache-control': 'no-store' }),
  );

  app.onError((error, c) => {
    // The only place an unhandled error is turned into a body. `redact` runs on
    // both halves: the log line and, when errors are exposed, the message —
    // an SDK error's `cause` is the likeliest carrier of a provider key.
    //
    // Wrapped, because logging must never be able to break the response. The
    // redactor is hardened against a throwing getter, but this handler is the
    // last thing between an exception and a blank 500 and it should not depend
    // on that being true forever.
    try {
      logger?.error('unhandled error', { path: c.req.path, method: c.req.method, error });
    } catch {
      // Nothing useful to do, and nothing may be printed: the value that broke
      // the redactor is the value that might carry the key.
    }
    const body: Record<string, unknown> = { error: 'internal' };
    if (options.exposeErrors) {
      body.hint = redactString(error instanceof Error ? error.message : String(error));
    }
    return c.json(body, 500, { 'cache-control': 'no-store' });
  });

  return app;
}

/**
 * Every spelling of this request's path that the gate must consider, or `null`
 * when the URL will not parse.
 *
 * `isGatedPath` matches a path prefix, and `/api/ask?x=1` is not `/api/ask` to a
 * string comparison. Hono's own `c.req.path` already strips the query, but the
 * gate is the one thing on this server whose failure is an invoice, so it reads
 * the URL rather than trusting a convenience.
 *
 * **Two spellings, not one, and an adversarial reviewer found out why.**
 * `URL.pathname` does not percent-decode; Hono's router matches the **decoded**
 * path. So `/api/%61sk` is "not gated" to a literal prefix match and is
 * nonetheless routed to the real `/api/ask` handler. Today that costs nothing —
 * `requireAccess` is the first line of every handler and refuses it, which is
 * exactly the redundancy `packages/access`'s header argues for and is good
 * evidence the redundancy is not ceremonial. It cost something the moment this
 * module's header claimed the front layer covers `/api/ask/propose` "already":
 * `/api/%61sk/propose` reached the router un-gated and 404'd, and when
 * `backend.md` B2 mounts that path it would have reached a route that spends
 * money with only one of the two checks in front of it.
 *
 * Both forms are tested, and a decode that throws (`%zz`) drops to the raw form
 * alone rather than failing the request — it cannot be a path the router will
 * match either.
 */
export function pathsOf(url: string): string[] | null {
  let raw: string;
  try {
    raw = new URL(url).pathname;
  } catch {
    return null;
  }
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === raw ? [raw] : [raw, decoded];
  } catch {
    return [raw];
  }
}

function mount(
  app: Hono,
  route: ServerRoute,
  byMethod: MethodHandlers,
  policy: CorsPolicy,
): void {
  for (const method of route.methods) {
    const handler = byMethod[method];
    if (!handler) continue;
    // Hono's `on` takes the verb as a string and registers exactly it; HEAD is
    // derived from GET by the runtime, so it is not registered separately.
    app.on(method, route.path, (c) => handler(c.req.raw));
  }
  // The preflight, per declared path rather than globally, so that `OPTIONS` to
  // a path this server does not have is a 404 like every other verb on it.
  // Registered before the catch-all below, which would otherwise answer 405.
  app.on('OPTIONS', route.path, (c) =>
    c.body(null, 204, {
      ...preflightHeaders(c.req.header('origin') ?? null, policy, route.methods),
      'cache-control': 'no-store',
    }),
  );
  // Anything the table did not declare on a declared path is a 405, not a 404:
  // the distinction is what tells a caller "wrong verb" from "no such route",
  // and `pnpm smoke` reads it.
  app.all(route.path, (c) =>
    c.json({ error: 'method-not-allowed' }, 405, {
      allow: route.methods.join(', '),
      'cache-control': 'no-store',
    }),
  );
}
