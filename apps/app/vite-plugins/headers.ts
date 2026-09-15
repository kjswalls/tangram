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
 * What it applies: **headers**, all matching rules, later key wins.
 *
 * **It deliberately applies no rewrites, and that is the correction W2's
 * adversarial review forced.** The first version of `vercel.json` negotiated
 * the dictionary's brotli sibling with a rewrite from `/dict-….sqlite` to
 * `/dict-….sqlite.br` under `accept-encoding`, and this plugin applied that
 * rewrite BEFORE Vite's static middleware — the opposite of the order the host
 * uses. Vercel consults `rewrites` only after the filesystem, and
 * `/dict-….sqlite` is a real file in `dist/`, so on the deployed host the
 * rewrite could never fire while the paired `content-encoding: br` header
 * still would: 43 MB of raw SQLite labelled brotli, which no browser can
 * decode. Every gate in this container was green, because this plugin was
 * quietly making the local server behave in a way the host would not. The
 * negotiation is gone; the sibling is served under its own name (`docs/deploy.md`
 * §3 rule 4), which is the fallback `web.md` W2 already named.
 *
 * The SPA fallback rewrite is Vite's own (`appType: 'spa'`) and is NOT applied
 * from here: Vercel checks the filesystem before its rewrites and Vite's
 * history fallback middleware runs after its static one, so the two agree
 * without this plugin repeating the pattern.
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
  matchRule,
  readHostConfig,
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

    for (const [key, value] of Object.entries(headersFor(config, request))) {
      res.setHeader(key, value);
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
    if (matchRule(fallback, request) !== null) {
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
