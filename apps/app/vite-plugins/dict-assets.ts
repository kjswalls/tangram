/**
 * Serves the dictionary artifacts in dev and preview (docs/plans/data.md D4).
 *
 * **This is a bridge, and `web.md` W2 replaces it.** Wave zero §6 gives W2 the
 * web delivery of `dict-<schema>-<cedict>.sqlite`, `dict-manifest.json` and
 * `decomp.json`: a build step copies all three into `apps/app/public/`, and the
 * host config carries the two caching rules. That work is landing in parallel
 * with this phase, on another branch, and D4 needs bytes to fetch today — so
 * this middleware answers the same three URLs out of the workspace-root `data/`
 * directory, with the same headers, and **stands down the moment the files
 * exist under `public/`**: it checks for a real file first and calls `next()`
 * when it finds one. When W2 lands, this plugin does nothing and can be deleted
 * in the same commit.
 *
 * Nothing here ships. `dist/` contains no server, and `pnpm dev`/`pnpm preview`
 * are the only two things that mount it — which is also where D4's Playwright
 * criteria run.
 *
 * The headers are not decoration. They are the rules `data.md` D4 states and
 * `web.md` W2 owns:
 *
 *   - the `.sqlite` is content-addressed (schema version and CC-CEDICT snapshot
 *     are both in the filename), so `public, max-age=31536000, immutable`;
 *   - `dict-manifest.json` is the *pointer* at that filename, so `no-cache`. An
 *     immutably cached pointer is a dictionary that can never be updated.
 *
 * Criterion 5 measures how many bytes a second tab re-fetches, and the answer
 * depends entirely on whether the browser's HTTP cache keeps a response this
 * size — so getting rule 1 right locally is what makes that measurement mean
 * anything.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';

import type { Connect, Plugin } from 'vite';

import { MANIFEST_FILE } from '../lib/dict/artifact.ts';
import { dataDir } from '../lib/server/roots.ts';
import { appRoot, dirOf } from '../lib/server/roots.ts';

/** `dict-1-1.3.20251213.sqlite`, and nothing else shaped like a path. */
const ARTIFACT = /^dict-\d+-[A-Za-z0-9._-]+\.sqlite$/;

const SERVED: Readonly<Record<string, string>> = {
  [`/${MANIFEST_FILE}`]: 'application/json; charset=utf-8',
  '/decomp.json': 'application/json; charset=utf-8',
};

function headersFor(name: string): Record<string, string> {
  if (ARTIFACT.test(name)) {
    return {
      'content-type': 'application/vnd.sqlite3',
      // Rule 4 of W2's host config, mirrored exactly.
      'cache-control': 'public, max-age=31536000, immutable',
    };
  }
  return {
    'content-type': SERVED[`/${name}`] ?? 'application/octet-stream',
    // Rule 5: the manifest is revalidated on every load. `decomp.json` is not
    // content-addressed either, so it gets the same treatment here.
    'cache-control': 'no-cache',
  };
}

function middleware(publicDir: string): Connect.NextHandleFunction {
  return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const host = req.headers.host ?? 'localhost';
    const { pathname } = new URL(req.url ?? '/', `http://${host}`);
    const name = basename(pathname);
    if (pathname !== `/${name}`) return next();
    if (!ARTIFACT.test(name) && !(`/${name}` in SERVED)) return next();
    // W2's copy step, once it lands, puts these in `public/`; Vite serves them
    // and this middleware must not shadow them with a different copy.
    if (existsSync(join(publicDir, name))) return next();

    const file = resolve(dataDir(), name);
    if (!existsSync(file)) return next();
    const { size } = statSync(file);

    for (const [key, value] of Object.entries(headersFor(name))) res.setHeader(key, value);
    res.setHeader('content-length', String(size));
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
      res.statusCode = 200;
      res.end();
      return;
    }
    res.statusCode = 200;
    /**
     * The stream is wired up by hand rather than with a bare `.pipe(res)`.
     *
     * This middleware sends a 43 MB body, repeatedly, to a suite that abandons
     * requests on purpose — Playwright route interception, a page closed
     * mid-import, a second tab that gives up. A `pipe` with no error handler
     * leaves the read stream's `error` event unhandled, and an unhandled
     * `error` on a stream **throws in the Node process**: the preview server
     * dies and every later spec in the run fails against a refused connection,
     * with nothing pointing back here. Destroying the stream when the response
     * closes is the other half — without it an abandoned request keeps reading
     * 43 MB off disk into a socket nobody is listening to.
     */
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}

export function dictAssets(): Plugin {
  const publicDir = join(appRoot(dirOf(import.meta.url)), 'public');
  return {
    name: 'tangram:dict-assets',
    configureServer: (server) => {
      server.middlewares.use(middleware(publicDir));
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware(publicDir));
    },
  };
}
