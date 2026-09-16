/**
 * Three things that only fail once the build is somewhere else
 * (docs/plans/web.md W2).
 *
 *  1. **`outputFileTracingIncludes`.** This one is **no longer a live
 *     deployment failure mode and the honest thing is to say so.** It was: when
 *     the app deployed as per-route serverless functions, a route that read the
 *     dictionary and was not listed worked under `next dev` and 500'd in the
 *     deployment, and `/api/examples` and `/api/recall` shipped exactly that
 *     way. From W2 the app deploys as **static files with no functions at all**
 *     (`docs/deploy.md`), so nothing reads `tracing.config.ts` and no route can
 *     500 in a deployment — because no route is in the deployment. What the
 *     three cases below still guard is the config's internal consistency for
 *     as long as the file exists, which `tracing.config.ts`'s own header ties
 *     to `data.md` D6 and `backend.md` taking the routes over. They are kept
 *     rather than deleted for that reason and for one more: the *value* check
 *     ("the key is not the whole answer") is the test that caught W0's
 *     silently-empty globs, and it is the pattern, not the config, that is
 *     worth keeping alive until the file goes.
 *  2. **A route or a page nobody exercises.** `pnpm smoke` is only as good as
 *     its case list, so a new API route with no case, or a page route with no
 *     DOM marker, has to fail *here*, cheaply.
 *  3. **The host config.** `apps/app/vercel.json` is the only place the five
 *     rules W1 deleted from `next.config.ts` now live, and `dist/` contains no
 *     server to notice their absence. Deleting any one of them fails this file.
 *
 * All three are answered from the import graph, the route table and the config,
 * not from memory.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MANIFEST_FILE, type DictManifest } from '@/lib/dict/artifact';
import {
  headersFor,
  matchRule,
  readHostConfig,
  rewriteFor,
  sourceToRegExp,
} from '@/lib/server/host-config';
import { appRoot, workspaceRoot } from '@/lib/server/roots';
import { TABS } from '@/components/shell/nav';
import { OUTPUT_FILE_TRACING_INCLUDES } from '@/tracing.config';
import {
  discoverApiRoutes,
  discoverPageRoutes,
  pageRouteUrl,
  readsDictionary,
  tracingKeyMatches,
  unmatchedTracingIncludes,
  untracedDictRoutes,
} from '@/lib/server/route-inventory';
import {
  checkRouteCoverage,
  pageCases,
  SMOKE_CASES,
  staticCases,
} from '../../../../../scripts/smoke';

const ROOT = appRoot(__dirname);
const HOST = readHostConfig(ROOT);
const DIST = resolve(ROOT, HOST.outputDirectory ?? 'dist');

/**
 * Every file the host would serve verbatim, at the path it would serve it from.
 *
 * Files, not directory entries: a directory is not something the filesystem
 * handle answers with, so including one would make the guard below refuse a
 * rewrite that is perfectly correct.
 */
function distFiles(dir: string = DIST, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const served = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...distFiles(resolve(dir, entry.name), served));
    else out.push(served);
  }
  return out;
}

/** The artifact the *current* `data/` holds, when `pnpm data` has run. */
function dictManifest(): DictManifest | null {
  const path = resolve(workspaceRoot(ROOT), 'data', MANIFEST_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DictManifest) : null;
}

describe('the route inventory', () => {
  const routes = discoverApiRoutes(ROOT);

  it('finds every API route, and each one exports a handler', () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
    expect(routes.map((route) => route.path)).toEqual(
      expect.arrayContaining([
        '/api/ask',
        '/api/dict/decomp',
        '/api/dict/entries',
        '/api/dict/hsk',
        '/api/dict/search',
        '/api/dict/segment',
        '/api/examples',
        '/api/recall',
      ]),
    );
    for (const route of routes) {
      expect(route.methods, route.relativeFile).not.toHaveLength(0);
    }
  });

  it('knows which routes reach the dictionary loader', () => {
    const reading = routes.filter((route) => readsDictionary(route, ROOT)).map((r) => r.path);
    // Every route in this app reads it except none — stated as a set rather
    // than a count so that adding a route that does *not* read it is also a
    // deliberate edit here.
    expect(reading).toEqual(
      expect.arrayContaining(['/api/ask', '/api/dict/search', '/api/examples', '/api/recall']),
    );
  });
});

describe('the page route table', () => {
  const pages = discoverPageRoutes(ROOT);

  it('is read out of src/routes.tsx and holds today’s five routes', () => {
    // An exact list on purpose: adding or removing a destination should be a
    // deliberate edit here, not something that slips past. `core.md` C7
    // collapsed the eight this used to name into three tabs plus two sub-paths,
    // and the table now derives them from `TAB_PATHS` — which is what
    // `discoverPageRoutes` learned to resolve when the two landed together.
    expect(pages.map((page) => page.pattern)).toEqual([
      '/',
      '/read',
      '/practice',
      '/library',
      '/library/lists/:id',
    ]);
  });

  it('never contains the dev-only routes, in any build', () => {
    // `/gallery` (core.md C1) and `/span-select` (C5a) reach the table by
    // spread from a build-mode guard, so they are absent by construction.
    // src/routes.tsx's own header says `pnpm smoke` needs no exemption and
    // that W2 must not add one; this is what holds it to that.
    const patterns = pages.map((page) => page.pattern);
    expect(patterns).not.toContain('/gallery');
    expect(patterns).not.toContain('/span-select');
  });

  it('covers every nav destination', () => {
    expect(pages.map((page) => page.pattern)).toEqual(
      expect.arrayContaining(TABS.map((tab) => tab.path)),
    );
  });

  it('gives every route a DOM marker, which is what makes the e2e falsifiable', () => {
    // Under the SPA fallback a page's status says nothing. The marker is the
    // assertion, so a route that has none is a route the suite cannot check —
    // and that has to fail here, where it is cheap, rather than by the e2e
    // silently having one fewer case.
    const markers = new Set<string>();
    for (const file of readFileSync(resolve(ROOT, 'src/routes.tsx'), 'utf8').matchAll(
      /from '\.\/routes\/([a-z-]+)'/g,
    )) {
      const source = readFileSync(resolve(ROOT, `src/routes/${file[1]}.tsx`), 'utf8');
      for (const marker of source.matchAll(/<RouteMarker path="([^"]+)"/g)) markers.add(marker[1]);
    }
    for (const page of pages) {
      expect(markers, `src/routes/** has no <RouteMarker path="${page.pattern}" />`).toContain(
        page.pattern,
      );
    }
  });

  it('makes a URL out of a parameterized pattern', () => {
    expect(pageRouteUrl({ pattern: '/lists/:id', parameterized: true })).toBe(
      '/lists/smoke-no-such-id',
    );
    expect(pageRouteUrl({ pattern: '/lookup', parameterized: false })).toBe('/lookup');
  });
});

describe('tracing coverage', () => {
  it('ships data/ to every route that reads it', () => {
    const untraced = untracedDictRoutes(
      discoverApiRoutes(ROOT),
      OUTPUT_FILE_TRACING_INCLUDES,
      ROOT,
    );
    expect(
      untraced.map((route) => route.path),
      'add an OUTPUT_FILE_TRACING_INCLUDES entry in tracing.config.ts for these',
    ).toEqual([]);
  });

  it('points those entries at files that exist — the key is not the whole answer', () => {
    // The regression this exists for: after the workspace move the globs still
    // read `./data/**`, which Next resolves from the PROJECT directory, and
    // `apps/app/data/` does not exist. Every key still matched its route, the
    // test above still passed, and the dictionary was in no bundle.
    expect(
      unmatchedTracingIncludes(OUTPUT_FILE_TRACING_INCLUDES, ROOT),
      'an OUTPUT_FILE_TRACING_INCLUDES glob in tracing.config.ts matches nothing on disk',
    ).toEqual([]);
  });

  it('traces the workspace marker, not only the data', () => {
    // `dataDir()` finds the workspace root by walking up for pnpm-workspace.yaml.
    // A bundle carrying data/ but not the marker resolves to the wrong directory.
    for (const [key, globs] of Object.entries(OUTPUT_FILE_TRACING_INCLUDES)) {
      expect(globs, `${key} must trace pnpm-workspace.yaml alongside data/`).toContain(
        '../../pnpm-workspace.yaml',
      );
    }
  });

  it('matches keys the way Next does, `**` included', () => {
    expect(tracingKeyMatches('/api/dict/**', '/api/dict/search')).toBe(true);
    // `**` also matches nothing, which is why `/api/ask/**` covers `/api/ask`.
    expect(tracingKeyMatches('/api/ask/**', '/api/ask')).toBe(true);
    expect(tracingKeyMatches('/api/ask/**', '/api/asking')).toBe(false);
    expect(tracingKeyMatches('/api/dict/**', '/api/ask')).toBe(false);
    expect(tracingKeyMatches('/api/recall', '/api/recall')).toBe(true);
  });
});

describe('smoke coverage', () => {
  it('has a case for every handler in app/api', () => {
    expect(checkRouteCoverage(ROOT), 'add a case to SMOKE_CASES in scripts/smoke.ts').toEqual([]);
  });

  it('walks every page route, derived from the table rather than copied', () => {
    const paths = pageCases(ROOT).map((smokeCase) => smokeCase.url({}));
    expect(paths).toEqual(discoverPageRoutes(ROOT).map(pageRouteUrl));
  });

  it('walks the three files the PWA needs, and the dictionary’s three', () => {
    const manifest = dictManifest();
    const paths = staticCases(manifest).map((smokeCase) => smokeCase.url({}));
    expect(paths).toEqual(
      expect.arrayContaining(['/offline.html', '/manifest.webmanifest', '/sw.js']),
    );
    if (manifest) {
      expect(paths).toEqual(
        expect.arrayContaining([`/${manifest.file}`, `/${MANIFEST_FILE}`, '/decomp.json']),
      );
    }
  });

  it('names a real route for every API case, so coverage cannot be faked', () => {
    const known = new Set(discoverApiRoutes(ROOT).map((route) => route.path));
    for (const smokeCase of SMOKE_CASES) {
      expect(smokeCase.route, smokeCase.name).not.toBeNull();
      expect(known.has(smokeCase.route as string), `${smokeCase.name} → ${smokeCase.route}`).toBe(
        true,
      );
    }
  });
});

describe('the host config (apps/app/vercel.json)', () => {
  it('builds the app rather than letting a framework preset guess', () => {
    // `docs/deploy.md` used to say "Vercel's Next.js preset is right out of the
    // box". There is no Next and no preset; the build command and the output
    // directory are config, not clicks, so that they are reviewable.
    expect(HOST.framework).toBeNull();
    expect(HOST.outputDirectory).toBe('dist');
    expect(HOST.buildCommand).toContain('data:ensure');
    expect(HOST.buildCommand).toContain('build');
  });

  it('rule 1 — falls back to index.html for a page path', () => {
    for (const page of discoverPageRoutes(ROOT)) {
      expect(rewriteFor(HOST, { pathname: pageRouteUrl(page) }), page.pattern).toBe('/index.html');
    }
    expect(rewriteFor(HOST, { pathname: '/nothing/here' })).toBe('/index.html');
  });

  it('rule 1 — and does NOT swallow /api, the assets, or a real file', () => {
    // `dist/` has no server. A catch-all rewrite answers `/api/dict/hsk?band=1`
    // with 200 `index.html`, so the missing-data probe reads healthy while
    // every dictionary call fails to parse. Found by W1's review, fixed here.
    expect(rewriteFor(HOST, { pathname: '/api/dict/hsk' })).toBeNull();
    // A deleted entry chunk must 404, not answer the document that references
    // it — otherwise the one failure the smoke exists to catch is invisible.
    expect(rewriteFor(HOST, { pathname: '/assets/index-abc123.js' })).toBeNull();
    for (const path of ['/sw.js', '/offline.html', '/manifest.webmanifest', '/decomp.json']) {
      expect(rewriteFor(HOST, { pathname: path }), path).toBeNull();
    }
  });

  it('rule 2 — the manifest is application/manifest+json', () => {
    // Some installability checks refuse anything else.
    expect(headersFor(HOST, { pathname: '/manifest.webmanifest' })['content-type']).toBe(
      'application/manifest+json; charset=utf-8',
    );
  });

  it('rule 3 — sw.js is revalidated, typed, and allowed the root scope', () => {
    const headers = headersFor(HOST, { pathname: '/sw.js' });
    expect(headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(headers['service-worker-allowed']).toBe('/');
  });

  it('rule 4 — the artifact’s content-addressed path is immutable for a year', () => {
    const manifest = dictManifest();
    // Against the filename `pnpm data` actually produced, not a made-up one: a
    // pattern that matches nothing is the failure this whole file is about.
    const name = manifest?.file ?? 'dict-1-1.3.20251213.sqlite';
    const headers = headersFor(HOST, { pathname: `/${name}` });
    expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(headers['content-type']).toBe('application/vnd.sqlite3');
  });

  it('rule 4 — the brotli sibling is served under its OWN name, decodable', () => {
    // **Not by content negotiation.** W2's first version rewrote
    // `/dict-….sqlite` to the sibling under `accept-encoding` and set
    // `content-encoding: br` on the same path. Vercel consults `rewrites` only
    // after the filesystem, and the `.sqlite` IS a file in `dist/`, so on the
    // deployed host only the header would have fired: 43 MB of raw SQLite
    // labelled brotli, which no browser can decode. The sibling now has its own
    // path and its own rules, which is the fallback `web.md` W2 already named.
    const name = dictManifest()?.file ?? 'dict-1-1.3.20251213.sqlite';
    const sibling = headersFor(HOST, { pathname: `/${name}.br` });
    expect(sibling['content-encoding']).toBe('br');
    expect(sibling['content-type']).toBe('application/vnd.sqlite3');
    expect(sibling['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('never claims an encoding it is not applying, and never rewrites a real file', () => {
    // The class of bug, not the instance: both halves of W2's first version
    // were individually reasonable and only wrong together, and both were green
    // locally because the preview plugin applied them in the host's opposite
    // order. `wave-zero.md` §10a names this shape twice; this is the third.
    const emitted = distFiles();
    expect(emitted.length, 'run pnpm build first').toBeGreaterThan(0);

    for (const pathname of emitted) {
      // Vercel: "the source property should NOT be a file, because precedence
      // is given to the filesystem prior to rewrites being applied."
      for (const rule of HOST.rewrites) {
        expect(
          matchRule(rule, { pathname, headers: { 'accept-encoding': 'gzip, deflate, br' } }),
          `${rule.source} → ${rule.destination} can never fire: ${pathname} is a real file in dist/`,
        ).toBeNull();
      }
      // …and a `content-encoding` on a path the filesystem serves verbatim is a
      // promise about bytes nobody re-encoded.
      const headers = headersFor(HOST, {
        pathname,
        headers: { 'accept-encoding': 'gzip, deflate, br' },
      });
      if (headers['content-encoding'] !== undefined) {
        expect(
          pathname.endsWith('.br'),
          `${pathname} claims content-encoding: ${headers['content-encoding']} but is served verbatim`,
        ).toBe(true);
      }
    }
  });

  it('serves the uncompressed artifact honestly, with no encoding claimed', () => {
    const name = dictManifest()?.file ?? 'dict-1-1.3.20251213.sqlite';
    const headers = headersFor(HOST, {
      pathname: `/${name}`,
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('rule 5 — the manifest that POINTS at rule 4 is not immutable', () => {
    // The two are halves of one decision: an immutable pointer is a dictionary
    // that can never be updated.
    const headers = headersFor(HOST, { pathname: `/${MANIFEST_FILE}` });
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['cache-control']).not.toContain('immutable');
  });

  it('gives decomp.json a stated delivery, revalidated because it is not hashed', () => {
    const headers = headersFor(HOST, { pathname: '/decomp.json' });
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('parses only the pattern subset it claims to, and throws on the rest', () => {
    expect(sourceToRegExp('/sw.js').regex.test('/sw.js')).toBe(true);
    // The `.` is a literal, not "any character" — a rule that also matched
    // `/swXjs` would be a rule matching more than it says.
    expect(sourceToRegExp('/sw.js').regex.test('/swXjs')).toBe(false);
    expect(sourceToRegExp('/:file(dict-.+\\.sqlite)').params).toEqual(['file']);
    // path-to-regexp's repeat modifiers change how many segments a parameter
    // eats. Silently mis-reading that is the class of bug this module exists
    // to avoid, so it refuses rather than guesses.
    expect(() => sourceToRegExp('/:path*')).toThrow(/modifier/);
  });
});
