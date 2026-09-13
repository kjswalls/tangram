/**
 * The two response headers `next.config.ts`'s `headers()` block supplied, for
 * the dev and preview servers (docs/plans/web.md W1).
 *
 * These are **host** rules and `web.md` W2 re-homes them into
 * `apps/app/vercel.json`. They are here so that `tests/e2e/p6/pwa.spec.ts` keeps
 * passing across this phase rather than going red now and coming back in W2 —
 * which is how an assertion gets quietly deleted. Nothing here ships; `dist/`
 * contains no server.
 *
 * Vite's own `preview.headers` option is a flat map applied to every response,
 * which would put `application/manifest+json` on the HTML. These are per path.
 */
import type { Connect, Plugin } from 'vite';

/** path → the headers a host must send for it. W2 mirrors this table exactly. */
export const STATIC_HEADERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // `public/` is served with a generic type for an unknown extension, and some
  // installability checks refuse a manifest that is not application/manifest+json.
  '/manifest.webmanifest': {
    'content-type': 'application/manifest+json; charset=utf-8',
  },
  // A worker at the root must be revalidated, or a bad one is permanent.
  '/sw.js': {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    'service-worker-allowed': '/',
  },
};

function middleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const host = req.headers.host ?? 'localhost';
    const { pathname } = new URL(req.url ?? '/', `http://${host}`);
    const headers = STATIC_HEADERS[pathname];
    if (headers) for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    next();
  };
}

export function staticHeaders(): Plugin {
  return {
    name: 'tangram:static-headers',
    configureServer: (server) => {
      server.middlewares.use(middleware());
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware());
    },
  };
}
