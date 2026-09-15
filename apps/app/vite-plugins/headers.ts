/**
 * The host's rules, applied to the dev and preview servers
 * (docs/plans/web.md W1 and W2).
 *
 * **This file used to hold its own copy of two header rules.** W2 wrote
 * `apps/app/vercel.json`, and a second hand-written table beside it is two
 * tables that can disagree — with the *deployed* one being the half nobody can
 * see from here. So the table is gone: this plugin reads `vercel.json` through
 * `lib/server/host-config.ts`, which is the same module the unit test asserts
 * against and the same one `scripts/smoke.ts` checks the served responses
 * against.
 *
 * Two things it applies, in Vercel's own order:
 *
 *  1. **Rewrites**, by rewriting `req.url` before Vite's static middleware sees
 *     it. Only one matters in the container — the artifact's `.br` sibling
 *     under `accept-encoding` negotiation — and it matters because otherwise
 *     nothing local would ever exercise it.
 *  2. **Headers**, all matching rules, later key wins.
 *
 * The SPA fallback rewrite is Vite's own (`appType: 'spa'`) and is NOT applied
 * from here: Vercel checks the filesystem before its rewrites and Vite's
 * history fallback middleware runs after its static one, so the two agree
 * without this plugin repeating the pattern. What this plugin must not do is
 * rewrite a page path to `/index.html` *before* the static middleware, which
 * would serve the document for a real file. `ruleApplies` is therefore called
 * only for rewrites whose destination is not `/index.html`.
 *
 * **And one thing it has to UNDO.** `vite preview` answers a missing
 * `/assets/<hash>.js` with 200 and `index.html`, because Vite's own history
 * fallback is unconditional. Vercel will not: `vercel.json`'s fallback excludes
 * `/api/`, `/assets/` and anything with a file extension precisely so that a
 * missing asset 404s. Leaving the two different would make the container's
 * proof of `web.md` W2's "delete the entry chunk and watch it fail" criterion
 * impossible — it was tried, and a build with no entry chunk passed everything.
 * So in **preview only**, a path the fallback excludes that is not on disk gets
 * a 404 here, before Vite's static layer ever sees it.
 *
 * **What this does not prove.** That Vercel reads `vercel.json` the way this
 * does. It cannot: `vite preview` is not Vercel. It proves the rules are
 * internally consistent and that the bytes they point at exist — the
 * deployment measurement in `docs/deploy.md` §7 is what proves the rest.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Connect, Plugin } from 'vite';

import { appRoot, dirOf } from '../lib/server/roots.ts';
import {
  headersFor,
  readHostConfig,
  rewriteFor,
  type HostConfig,
  type HostRequest,
} from '../lib/server/host-config.ts';

const APP_ROOT = appRoot(dirOf(import.meta.url));

/** The one rewrite this plugin must leave to Vite. */
const SPA_FALLBACK = '/index.html';

function toHostRequest(req: Connect.IncomingMessage): HostRequest {
  const host = req.headers.host ?? 'localhost';
  const { pathname } = new URL(req.url ?? '/', `http://${host}`);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
  }
  return { pathname, headers };
}

function middleware(config: HostConfig): Connect.NextHandleFunction {
  const rewrites = config.rewrites.filter((rule) => rule.destination !== SPA_FALLBACK);
  const routing: HostConfig = { ...config, rewrites };
  return (req, res, next) => {
    let request: HostRequest;
    try {
      request = toHostRequest(req);
    } catch {
      // Node's HTTP parser accepts request targets the WHATWG URL parser
      // rejects. Not this middleware's business to answer them.
      next();
      return;
    }

    for (const [key, value] of Object.entries(headersFor(routing, request))) {
      res.setHeader(key, value);
    }

    const rewritten = rewriteFor(routing, request);
    if (rewritten !== null && rewritten !== request.pathname) {
      const query = (req.url ?? '').slice((req.url ?? '').indexOf('?') + 1);
      req.url = (req.url ?? '').includes('?') ? `${rewritten}?${query}` : rewritten;
    }
    next();
  };
}

/**
 * The host's 404, for the paths its SPA fallback deliberately does not cover.
 *
 * Preview only. Under `pnpm dev` the hashed assets do not exist on disk at all
 * — Vite serves them out of the module graph — so asking the filesystem about
 * them would 404 the entire dev server.
 */
function notFound(config: HostConfig, distDir: string): Connect.NextHandleFunction {
  const fallback = config.rewrites.find((rule) => rule.destination === SPA_FALLBACK);
  return (req, res, next) => {
    if (!fallback) {
      next();
      return;
    }
    let request: HostRequest;
    try {
      request = toHostRequest(req);
    } catch {
      next();
      return;
    }
    // `/api/**` is the adapter's, and it answers its own 404s (web.md W1).
    if (request.pathname.startsWith('/api/')) {
      next();
      return;
    }
    // Covered by the fallback: the host would answer index.html, and so does
    // Vite. Nothing to do.
    if (rewriteFor({ ...config, rewrites: [fallback] }, request) !== null) {
      next();
      return;
    }
    const onDisk = resolve(distDir, request.pathname.replace(/^\/+/, ''));
    if (onDisk.startsWith(distDir) && existsSync(onDisk) && statSync(onDisk).isFile()) {
      next();
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`404 ${request.pathname}\n`);
  };
}

export function staticHeaders(): Plugin {
  return {
    name: 'tangram:host-config',
    configureServer: (server) => {
      server.middlewares.use(middleware(readHostConfig(APP_ROOT)));
    },
    configurePreviewServer: (server) => {
      const config = readHostConfig(APP_ROOT);
      server.middlewares.use(middleware(config));
      server.middlewares.use(
        notFound(config, resolve(APP_ROOT, config.outputDirectory ?? 'dist')),
      );
    },
  };
}
