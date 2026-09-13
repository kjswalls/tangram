/**
 * The dev/preview API adapter (docs/plans/web.md W1).
 *
 * **This is a bridge, not a product.** It mounts the existing
 * `app/api/<route>/route.ts` handlers in the dev server and the preview server so
 * that `/api/dict/*` keeps answering until `data.md` deletes those five routes,
 * and `/api/ask`, `/api/examples` and `/api/recall` keep answering until
 * `backend.md` has a server. It never ships: it is not in `dist/`, and the phase
 * that removes the last handler removes it too.
 *
 * It reuses `discoverApiRoutes()` from `lib/server/route-inventory.ts`, which is
 * the machinery STACK §2.2 calls "the fifth, smaller casualty" of leaving Next.
 * Deriving the route table from the same source the tracing guard and
 * `pnpm smoke` read is what stops a route existing in one list and not another.
 *
 * Three details decide whether it works, and none of them is optional:
 *
 *  1. **The handler contract is `(request: Request) => Response | Promise<Response>`
 *     and both shapes are live.** Of the ten handlers, four are `async` and six
 *     return synchronously, so every call is awaited.
 *  2. **It dispatches by method**, because `ask` and `examples` each export both
 *     `GET` and `POST`.
 *  3. **It derives `HEAD` from `GET`** — calls the `GET` handler and returns its
 *     status and headers with the body dropped. `components/shell/data-banner.tsx`
 *     probes `/api/dict/hsk?band=1` with `HEAD` and reads only the status; Next
 *     synthesised that from `GET` and nothing else will. Without it the
 *     missing-data banner silently stops working and the failure looks like a
 *     data problem.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';

import { appRoot, dirOf } from '../lib/server/roots.ts';
import { discoverApiRoutes, type ApiRoute, type HttpMethod } from '../lib/server/route-inventory.ts';

/** What a route module exports per verb. Six of the ten are synchronous. */
type RouteHandler = (request: Request) => Response | Promise<Response>;
type RouteModule = Partial<Record<HttpMethod, RouteHandler>>;
type LoadModule = (file: string) => Promise<RouteModule>;

const APP_ROOT = appRoot(dirOf(import.meta.url));

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one);
  }
  const method = (req.method ?? 'GET').toUpperCase();
  // GET and HEAD must not carry a body; anything else forwards what arrived.
  const init: RequestInit = { method, headers };
  // `new Uint8Array(...)` rather than the Buffer: Buffer is not a `BodyInit`.
  if (method !== 'GET' && method !== 'HEAD' && body.length > 0) init.body = new Uint8Array(body);
  return new Request(url, init);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function writeResponse(res: ServerResponse, response: Response, dropBody: boolean) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (dropBody || response.body === null) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * The route table, read once per server start from the same walk the tracing
 * guard and `pnpm smoke` use.
 */
function routeTable(): Map<string, ApiRoute> {
  return new Map(discoverApiRoutes(APP_ROOT).map((route) => [route.path, route]));
}

function middleware(routes: Map<string, ApiRoute>, load: LoadModule): Connect.NextHandleFunction {
  return (req, res, next) => {
    void (async () => {
      const host = req.headers.host ?? 'localhost';
      const { pathname } = new URL(req.url ?? '/', `http://${host}`);
      const route = routes.get(pathname);
      if (!route) return next();

      const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
      // HEAD is answered by GET with the body dropped — see the header above.
      const verb: HttpMethod = method === 'HEAD' ? 'GET' : method;

      try {
        const module = await load(route.file);
        const handler = module[verb];
        if (!handler) {
          res.statusCode = 405;
          res.setHeader('Allow', route.methods.join(', '));
          res.end();
          return;
        }
        const body = await readBody(req);
        // Awaited either way: four handlers are async, six are not.
        const response = await handler(toRequest(req, body));
        await writeResponse(res, response, method === 'HEAD');
      } catch (cause) {
        // A throwing handler is a bug in the handler, not a 404. Surface it.
        console.error(`api adapter: ${method} ${pathname} threw`, cause);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'api-adapter-threw', route: route.path }));
      }
    })();
  };
}

export function apiRoutes(): Plugin {
  return {
    name: 'tangram:api-routes',
    apply: () => true,

    configureServer(server: ViteDevServer) {
      const routes = routeTable();
      // In dev the handlers go through the dev server's own module runner, so
      // they are transformed, HMR-aware and share the app's resolution.
      const load: LoadModule = (file) => server.ssrLoadModule(file) as Promise<RouteModule>;
      server.middlewares.use(middleware(routes, load));
    },

    configurePreviewServer(server: PreviewServer) {
      const routes = routeTable();
      /**
       * The preview server has no transform pipeline — it serves `dist/`
       * statically — so a plain `import('./app/api/ask/route.ts')` from Node is
       * a resolution error. **Mechanism (a) of the two web.md W1 offers:**
       * preview is started from `scripts/preview.ts` under `tsx`, whose loader
       * hook compiles these modules on import. `tsx` is already a direct
       * devDependency and is already how `pnpm data`, `pnpm sw` and
       * `pnpm smoke` execute TypeScript under Node, so this adds no dependency
       * and no second build step. Recorded in HANDOFF.md.
       */
      const load: LoadModule = (file) =>
        import(pathToFileURL(file).href) as Promise<RouteModule>;
      server.middlewares.use(middleware(routes, load));
    },
  };
}
