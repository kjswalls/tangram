/**
 * Three things that only fail once the build is somewhere else
 * (docs/plans/web.md W2).
 *
 *  1. **A route or a page nobody exercises.** `pnpm smoke` is only as good as
 *     its case list, so an API route with no case, or a page route with no DOM
 *     marker, has to fail *here*, cheaply. The API half of that question is
 *     answered from `apps/server/src/routes/table.ts` now: `backend.md` B1
 *     moved the three model routes out of this app and there is no `app/api/`
 *     left to walk.
 *  2. **The host config.** `apps/app/vercel.json` is the only place the five
 *     rules W1 deleted from `next.config.ts` now live, and `dist/` contains no
 *     server to notice their absence. Deleting any one of them fails this file.
 *
 * **`outputFileTracingIncludes` is gone, and that is a deletion rather than a
 * lapse.** It guarded a real production-only failure — a route that read the
 * dictionary and was missing from the map worked in dev and 500'd in the
 * deployment, which `/api/examples` and `/api/recall` both shipped — and W2
 * kept its three cases alive after the app went static, on the grounds that the
 * *pattern* was worth keeping until the file went. `tracing.config.ts`'s own
 * header named the commit that should take it: "when `data.md` D6 deletes the
 * dictionary routes and `backend.md` owns the remaining three", and it warned
 * that silently dropping the test is the failure the paragraph existed to
 * prevent. B1 is that commit, the file is deleted, and this is the notice.
 * `apps/server/tests/routes.test.ts` carries the guard's purpose forward in the
 * shape that deployable needs.
 *
 * Both are answered from the route tables and the config, not from memory.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

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
import { discoverPageRoutes, pageRouteUrl } from '@/lib/server/route-inventory';
import { ROUTES as SERVER_ROUTES } from '../../../../server/src/routes/table.ts';
import {
  appCalledRoutes,
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

describe('the API this app calls', () => {
  it('has no app/api directory left — the three model routes are the server\u2019s', () => {
    // B1's move, asserted from the app's side. A `route.ts` reappearing here
    // would be a route nothing mounts, nothing smokes and nothing traces:
    // `vite-plugins/api.ts` was deleted in the same commit, so a handler under
    // `app/api/` would not even answer in dev.
    expect(existsSync(resolve(ROOT, 'app/api'))).toBe(false);
  });

  it('is declared by apps/server, and today that is exactly five paths', () => {
    // Exact, not `arrayContaining`: `data.md` D6 deleted the five dictionary
    // routes and B1 moved three here, so a sixth appearing is something nobody
    // decided. **This is `backend.md` B2's deliberate edit**, which the previous
    // version of this comment predicted: the single `POST /api/ask` became
    // `/api/ask/propose` and `/api/ask/answer`, and `/api/ask` is the handshake
    // alone. What did NOT need an edit is the coverage check: `appCalledRoutes()`
    // derives the set from the table's `gated` column rather than from a
    // literal, so the two new routes were covered the moment they were declared.
    // `GATED_PATHS` in `@tangram/access` is the same set from the gate's side
    // and `apps/server/tests/routes.test.ts` holds the two together.
    expect(appCalledRoutes().map((route) => route.path).sort()).toEqual([
      '/api/ask',
      '/api/ask/answer',
      '/api/ask/propose',
      '/api/examples',
      '/api/recall',
    ]);
    const declared = SERVER_ROUTES.map((route) => route.path);
    for (const route of appCalledRoutes()) expect(declared, route.path).toContain(route.path);
  });

  it('routes every call through apiFetch, so the API base and the header are applied', () => {
    // The dead-path check for B1's removal of the dev adapter. Until B1 an
    // app-side `fetch('/api/…')` worked by accident — the preview server
    // mounted the handlers on the app's own origin — so a call that skipped
    // `apiFetch` was invisible. It is now a call to a path the static host
    // answers with `index.html`, or 404s, and the feature is simply dead.
    // `packages/ai/recall.ts` was exactly that and B1 fixed it; this is what
    // stops the next one.
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/\bfetch(?:Impl)?\(\s*['"`](\/api\/[^'"`]*)['"`]/g)) {
        offenders.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect(offenders, 'these fetch an API path directly; go through apiFetch').toEqual([]);
  });

  it('keeps @server/* out of everything but the tests', () => {
    // The alias exists in `vitest.config.ts` and NOT in `vite.config.ts`, so a
    // production import of it fails the build rather than shipping server code
    // to a browser — but it is also in `tsconfig.json`, which covers the whole
    // app, so `tsc` would not complain and the failure would land in the
    // bundler. `backend.md` B1's route tests are the only legitimate users:
    // they stay in this app's suite because they need the real 124k-entry
    // dictionary in `data/`, which the server package will not ship after B2.
    const offenders = sourceFiles(ROOT)
      .map((file) => relative(ROOT, file))
      // `vitest.config.ts` is where the alias is DECLARED, which is the one
      // place the string legitimately appears outside a test.
      .filter((file) => file !== 'vitest.config.ts')
      .filter((file) => withoutComments(readFileSync(resolve(ROOT, file), 'utf8')).includes('@server/'));
    expect(offenders, 'only tests/ may import @server/*').toEqual([]);
  });
});

/**
 * The source with its comments blanked out.
 *
 * Crude — it does not know about a `//` inside a string — and deliberately so:
 * over-blanking can only *miss* an offender, and the alternative is a parser in
 * a test. What it is for is the opposite direction: half the files that
 * describe this rule quote the very call the rule forbids, so a scan that read
 * comments would report its own documentation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every first-party `.ts`/`.tsx` under the app, excluding tests and the build output. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `dist-gated` is `tests/e2e/d/access-gate.spec.ts`'s second build,
    // `dist-sub` is `tests/e2e/d/origin-agnostic.spec.ts`'s, and the two
    // `dist-*-check` directories are `core/gallery-excluded.spec.ts`'s. Each is
    // removed by the spec that makes it; an interrupted run leaves one behind.
    if (
      ['node_modules', 'dist', 'dist-gated', 'dist-sub', 'dist-prod-check', 'dist-e2e-check', 'tests', 'ios', 'android', '.vite'].includes(
        entry.name,
      )
    ) {
      continue;
    }
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

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

describe('smoke coverage', () => {
  it('has a case for every method of every route the app calls', () => {
    expect(checkRouteCoverage(), 'add a case to SMOKE_CASES in scripts/smoke.ts').toEqual([]);
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
    const known = new Set(SERVER_ROUTES.map((route) => route.path));
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
    // `dist/` has no server. A catch-all rewrite answers an `/api/**` path with
    // 200 `index.html`, so a probe reads healthy while every call fails to
    // parse. Found by W1's review against the dictionary routes `data.md` D6
    // has since deleted; the rule is about `/api/**`, so it is asserted against
    // a path under it that does exist and one that does not.
    expect(rewriteFor(HOST, { pathname: '/api/ask' })).toBeNull();
    expect(rewriteFor(HOST, { pathname: '/api/nothing/here' })).toBeNull();
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
