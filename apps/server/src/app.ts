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

import { redact, type Logger } from './log.ts';
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
 * Typed as a total map over `ROUTES`' paths at construction time — `buildApp`
 * throws if the table names a path with no handler, so a table entry added
 * without an implementation fails at boot rather than 404ing in the deployment.
 */
type RouteHandlers = Record<string, (request: Request) => Response | Promise<Response>>;

export function buildApp(options: AppOptions = {}): Hono {
  const startedAt = options.startedAt ?? Date.now();
  const logger = options.logger;
  const app = new Hono();

  const handlers: RouteHandlers = {
    '/health': () => health(startedAt),
  };

  for (const route of options.routes ?? ROUTES) {
    const handler = handlers[route.path];
    if (!handler) {
      throw new Error(`routes/table.ts declares ${route.path} but app.ts has no handler for it`);
    }
    mount(app, route, handler);
  }

  app.notFound((c) =>
    c.json({ error: 'not-found' }, 404, { 'cache-control': 'no-store' }),
  );

  app.onError((error, c) => {
    // The only place an unhandled error is turned into a body. `redact` runs on
    // both halves: the log line and, when errors are exposed, the message —
    // an SDK error's `cause` is the likeliest carrier of a provider key.
    logger?.error('unhandled error', { path: c.req.path, method: c.req.method, error });
    const body: Record<string, unknown> = { error: 'internal' };
    if (options.exposeErrors) body.hint = redact(error instanceof Error ? error.message : String(error));
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
