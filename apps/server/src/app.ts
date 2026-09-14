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
 */
import { Hono } from 'hono';

import { redactString, type Logger } from './log.ts';
import { health } from './routes/health.ts';
import { ROUTES, type ServerRoute } from './routes/table.ts';

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
}

/**
 * The handler for each declared path.
 *
 * **The check is symmetric, and the second half is the one that matters.** A
 * table entry with no handler throws at boot — easy, and the rarer direction. A
 * *handler* with no table entry is the one B1 will hit, because B1 adds
 * handlers: it is never mounted, `mountedPaths()` is derived from the table so
 * the route test cannot see it, `smoke.ts` walks the table so the smoke never
 * probes it, and every gate stays green while `POST /api/ask` 404s in the
 * deployment. That is precisely the failure `routes/table.ts`'s header says the
 * table exists to prevent, so `buildApp` throws for it too.
 */
type RouteHandlers = Record<string, (request: Request) => Response | Promise<Response>>;

export function buildApp(options: AppOptions = {}): Hono {
  const startedAt = options.startedAt ?? Date.now();
  const logger = options.logger;
  const app = new Hono();

  const handlers: RouteHandlers = {
    '/health': () => health(startedAt),
  };

  const table = options.routes ?? ROUTES;
  for (const route of table) {
    const handler = handlers[route.path];
    if (!handler) {
      throw new Error(`routes/table.ts declares ${route.path} but app.ts has no handler for it`);
    }
    mount(app, route, handler);
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

function mount(
  app: Hono,
  route: ServerRoute,
  handler: (request: Request) => Response | Promise<Response>,
): void {
  for (const method of route.methods) {
    // Hono's `on` takes the verb as a string and registers exactly it; HEAD is
    // derived from GET by the runtime, so it is not registered separately.
    app.on(method, route.path, (c) => handler(c.req.raw));
  }
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
