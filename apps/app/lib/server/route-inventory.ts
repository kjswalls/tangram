/**
 * What page routes this app has, and what a URL for one looks like.
 *
 * **It used to answer a second question and no longer has to.** Until
 * `backend.md` B1 this module also walked `app/api/**\/route.ts` and its import
 * graph, because of one production-only failure mode: the dictionary was read
 * from disk at request time, and on Vercel every route was traced and bundled
 * separately, so a route that reached the loader and was missing from
 * `outputFileTracingIncludes` worked in dev and 500'd in the deployment.
 * `/api/examples` and `/api/recall` were exactly that, and it took someone
 * opening the page to notice.
 *
 * `data.md` D6 deleted the five dictionary routes. B1 moved the surviving three
 * to `apps/server`, so **`apps/app` has no `app/api/` at all** — there is no
 * route to trace, `tracing.config.ts` is gone with its test, and `apps/server`
 * carries the guard's purpose forward in its own shape:
 * `apps/server/src/routes/table.ts` is the single source of truth there, and
 * `apps/server/tests/routes.test.ts` fails in both directions if a handler and
 * the table disagree. `tracing.config.ts`'s own header asked to be deleted "in
 * the same commit as the thing they guarded"; this is that commit.
 *
 * What is left here is the page half, which `web.md` W2 built and owns
 * (`wave-zero.md` §3): `scripts/smoke.ts` reads it so every page route of a
 * built server is exercised over HTTP, and `tests/unit/server/routes.test.ts`
 * turns "a route with no DOM marker" into a failing test.
 *
 * Node-only (it reads source files). Nothing in the app imports it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The HTTP methods a smoke case may name.
 *
 * It outlived the route walker: `scripts/smoke.ts` types every case with it,
 * and the page and static cases are `GET`.
 */
export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** The route table React Router is built from. `web.md`'s file; `core.md` C7 edits it. */
export const PAGE_ROUTE_TABLE = 'src/routes.tsx';

/** Where `TAB_PATHS` lives. `core.md` C7 made the route table derive from it. */
export const TAB_PATHS_SOURCE = 'components/shell/nav.ts';

/**
 * `TAB_PATHS`, scraped rather than imported.
 *
 * `core.md` C7 stopped writing route patterns as literals in the table and
 * started deriving them — `{ path: TAB_PATHS.practice.slice(1) }` — so the nav
 * and the router cannot disagree. That is the better invariant and it stays.
 * But this module is a **static** reader by design: `scripts/smoke.ts` is a
 * dependency-free CLI so the after-deploy checklist never needs a bundler, and
 * importing `nav.ts` here would pull a `.tsx` component graph into it.
 *
 * So the reference is resolved the same way the table is: by reading the file.
 * `TAB_PATHS` is a flat object of string literals and a `const` assertion,
 * which is exactly what makes that safe — and if it ever stops being one, the
 * caller below throws rather than guessing.
 */
function readTabPaths(repoRoot: string): Map<string, string> {
  const source = readFileSync(resolve(repoRoot, TAB_PATHS_SOURCE), 'utf8');
  const start = source.indexOf('export const TAB_PATHS');
  if (start === -1) {
    throw new Error(`${TAB_PATHS_SOURCE} has no \`export const TAB_PATHS\` declaration`);
  }
  const body = source.slice(start, source.indexOf('}', start));
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(\w+):\s*'([^']*)'/g)) out.set(match[1], match[2]);
  if (out.size === 0) throw new Error(`${TAB_PATHS_SOURCE}: TAB_PATHS yielded no paths`);
  return out;
}

export interface PageRoute {
  /** The pattern, e.g. `/`, `/lookup`, `/lists/:id`. Also the DOM marker's value. */
  pattern: string;
  /** True when the pattern carries a `:param` and a URL has to be made up. */
  parameterized: boolean;
}

/**
 * Every page route in the **production** table, read out of `src/routes.tsx`.
 *
 * Read out of the source rather than imported, and that is not laziness.
 * `routes.tsx` is TSX holding JSX elements and `import.meta.env` constants
 * Vite substitutes at build time; importing it from Node means a JSX runtime, a
 * transform and a fake `import.meta.env`, and the `import.meta.env.DEV` guard
 * would then answer for the *test* environment rather than for the build. The
 * source says what a production build contains and nothing has to be simulated.
 *
 * Only the `export const routes` declaration is read. `/gallery` and
 * `/span-select` sit in `devOnlyRoutes` and `devOnlyStandalone` and reach the
 * table by spread, so they are absent from it by construction — which is why
 * `routes.tsx`'s own header can say `pnpm smoke` needs no exemption and **W2
 * must not add one**.
 *
 * The catch-all `*` is skipped: it is the 404, it has no marker of its own, and
 * asserting it renders "the app" is what `not-found` already does.
 */
export function discoverPageRoutes(repoRoot: string): PageRoute[] {
  const file = resolve(repoRoot, PAGE_ROUTE_TABLE);
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('export const routes');
  if (start === -1) {
    throw new Error(`${PAGE_ROUTE_TABLE} has no \`export const routes\` declaration`);
  }
  const table = source.slice(start);

  const out: PageRoute[] = [];
  const seen = new Set<string>();
  // `index: true` is the parent path itself; every other entry is a `path:`
  // string literal, relative to the parent unless it starts with `/`.
  //
  // **Every quote style, and a THROW for anything else.** The first version
  // read single quotes only, so `{ path: "practice" }` or a template literal
  // would have been invisible to all four consumers at once — the marker test,
  // the Playwright spec, the smoke's page cases and the nav-coverage check —
  // and every one of them would have stayed green. That is precisely the
  // failure W2's first acceptance criterion exists to prevent (a route nobody
  // exercises), and `core.md` C7 is about to rewrite this table. A parse that
  // cannot see a route has to be loud, exactly as this file already is about a
  // route file that exports no handler.
  //
  // `TAB_PATHS.<key>` and `TAB_PATHS.<key>.slice(1)` are read too, because C7
  // derives the table from them (see `readTabPaths`). Anything else still
  // throws: the point is that this cannot silently miss a route, not that it
  // understands TypeScript.
  const tabPaths = readTabPaths(repoRoot);
  const pattern =
    /\bindex:\s*true|\bpath:\s*(['"`])((?:[^\\]|\\.)*?)\1|\bpath:\s*TAB_PATHS\.(\w+)(\.slice\(1\))?|\bpath:\s*([^'"`\s])/g;
  for (const match of table.matchAll(pattern)) {
    if (match[5] !== undefined) {
      throw new Error(
        `${PAGE_ROUTE_TABLE}: a \`path:\` this cannot read (${match[0].trim()}…). ` +
          'Route patterns must be plain quoted strings or TAB_PATHS references, or ' +
          'nothing derived from this table will know the route exists.',
      );
    }
    let raw = match[2];
    if (match[3] !== undefined) {
      const resolved = tabPaths.get(match[3]);
      if (resolved === undefined) {
        throw new Error(
          `${PAGE_ROUTE_TABLE}: \`TAB_PATHS.${match[3]}\` is not in ${TAB_PATHS_SOURCE}.`,
        );
      }
      // `.slice(1)` in the table makes the pattern relative to the layout route;
      // the branch below re-adds the leading slash either way.
      raw = match[4] === undefined ? resolved : resolved.slice(1);
    }
    let pattern: string;
    if (raw === undefined) pattern = '/';
    else if (raw === '*') continue;
    else if (raw === '/') continue; // the layout route; its `index` is the page
    else pattern = raw.startsWith('/') ? raw : `/${raw}`;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push({ pattern, parameterized: pattern.includes(':') });
  }
  if (out.length === 0) throw new Error(`${PAGE_ROUTE_TABLE} yielded no page routes`);
  return out;
}

/**
 * A URL a browser or a `fetch` can actually be pointed at.
 *
 * A parameterized route needs a value, and the value is deliberately a fixed
 * nonsense id rather than a real one: the assertion is that the *route* renders
 * its shell, and a route that only renders for data that exists is a route with
 * no empty state.
 */
export const PAGE_ROUTE_SAMPLE_PARAM = 'smoke-no-such-id';

export function pageRouteUrl(route: PageRoute): string {
  return route.pattern.replace(/:[A-Za-z0-9_]+/g, PAGE_ROUTE_SAMPLE_PARAM);
}
