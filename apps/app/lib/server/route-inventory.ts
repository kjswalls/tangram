/**
 * What routes this app has — API and page — what they import, and whether the
 * build is configured to ship them the files they read.
 *
 * This exists because of one production-only failure mode. `data/dict.json` is
 * read from disk at request time, and on Vercel every route is traced and
 * bundled **separately**: a route that reaches `lib/dict/load.ts` but is missing
 * from `outputFileTracingIncludes` in `next.config.ts` works perfectly under
 * `next dev` and under `pnpm start` — the file is simply on disk in both — and
 * 500s in the deployment, on that route only. `/api/examples` and `/api/recall`
 * were exactly that, and it took someone opening the page to notice.
 *
 * So the question "which routes read the dictionary" is answered here by
 * walking the import graph, rather than by remembering. `tests/unit/server/`
 * turns the answer into a failing test, and `scripts/smoke.ts` reads the same
 * inventory to make sure every route is actually exercised over HTTP.
 *
 * Node-only (it reads source files). Nothing in the app imports it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** The HTTP methods Next treats as route handlers. */
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

export interface ApiRoute {
  /** The URL path, e.g. `/api/dict/search`. */
  path: string;
  /** Absolute path of the `route.ts` file. */
  file: string;
  /** Repo-relative, for a readable failure message. */
  relativeFile: string;
  /** The handlers it exports, in `HTTP_METHODS` order. */
  methods: HttpMethod[];
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === 'route.ts' || name === 'route.tsx') out.push(full);
  }
  return out;
}

/**
 * Every `app/api/**\/route.ts`, with the methods it exports.
 *
 * The methods are read out of the source rather than by importing the module:
 * importing a route handler pulls in the provider, the dictionary loader and
 * everything else it touches, and this has to be cheap enough to run in a unit
 * test.
 */
export function discoverApiRoutes(repoRoot: string): ApiRoute[] {
  const appDir = resolve(repoRoot, 'app');
  return walk(resolve(appDir, 'api')).map((file) => {
    const source = readFileSync(file, 'utf8');
    const methods = HTTP_METHODS.filter((method) =>
      new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`, 'm').test(source),
    );
    const path = `/${relative(appDir, dirname(file)).split(/[\\/]/).join('/')}`;
    return { path, file, relativeFile: relative(repoRoot, file), methods };
  });
}


// ---------------------------------------------------------------------------
// Page routes (docs/plans/web.md W2)
// ---------------------------------------------------------------------------

/** The route table React Router is built from. `web.md`'s file; `core.md` C7 edits it. */
export const PAGE_ROUTE_TABLE = 'src/routes.tsx';

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
  for (const match of table.matchAll(/\bindex:\s*true|\bpath:\s*(['"`])((?:[^\\]|\\.)*?)\1|\bpath:\s*([^'"`\s])/g)) {
    if (match[3] !== undefined) {
      throw new Error(
        `${PAGE_ROUTE_TABLE}: a \`path:\` this cannot read (${match[0].trim()}…). ` +
          'Route patterns must be plain quoted strings, or nothing derived from this ' +
          'table will know the route exists.',
      );
    }
    const raw = match[2];
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

/** Every specifier a module imports or re-exports, static and dynamic. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/** Resolve one specifier to a file in this repo, or null if it leaves it. */
function resolveSpecifier(specifier: string, fromFile: string, repoRoot: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = resolve(repoRoot, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null; // a package, or `node:` — not ours to walk

  for (const candidate of [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Every first-party module reachable from `entry`, including `entry` itself.
 *
 * A regex over the source rather than a real parser: it over-approximates (a
 * specifier inside a comment or a string counts) and that is the safe direction
 * — the answer drives "does this route need the dictionary traced into it", and
 * tracing a file a route does not read costs a few megabytes, while missing one
 * it does read is a 500.
 */
export function moduleGraph(entry: string, repoRoot: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of specifiers(source)) {
      const resolved = resolveSpecifier(specifier, file, repoRoot);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/** The module that reads `data/*.json` off the disk. */
export const DICT_LOADER = 'lib/dict/load.ts';

/** Does this route reach the dictionary loader, and so need its data traced in? */
export function readsDictionary(route: ApiRoute, repoRoot: string): boolean {
  const loader = resolve(repoRoot, DICT_LOADER);
  return moduleGraph(route.file, repoRoot).has(loader);
}

/**
 * Does an `outputFileTracingIncludes` key cover this route path?
 *
 * Next matches those keys against the page path with glob semantics, where
 * `**` also matches nothing — `/api/ask/**` covers `/api/ask` itself. Only the
 * two wildcards are supported here, which is all the config uses.
 */
export function tracingKeyMatches(key: string, routePath: string): boolean {
  const pattern = key
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/\*\*/g, '(?:/.*)?')
    .replace(/(?<!\.)\*(?!\*)/g, '[^/]*')
    .replace(/\*\*/g, '.*');
  return new RegExp(`^${pattern}$`).test(routePath);
}

/**
 * Include globs that match no file on disk.
 *
 * `untracedDictRoutes` below answers "is there a KEY for this route", which was
 * the whole question while the Next project directory and the workspace root
 * were the same directory. They are not any more: `data/` is at the workspace
 * root and the globs are resolved with cwd set to the project directory, so
 * `./data/**` went on being a perfectly well-formed entry that matched nothing,
 * and every gate stayed green because `next dev`, `next start`, `pnpm smoke`
 * and the e2e suite all read `data/` off local disk. Only a deployment would
 * have noticed, which is the same way `/api/examples` and `/api/recall` got out.
 *
 * So the VALUE is checked too, against the filesystem, from the directory Next
 * resolves it from. Only the `**` suffix form the config uses is understood;
 * anything else is treated as a literal path, which is the safe reading — a
 * pattern this cannot verify should fail rather than pass.
 */
export function unmatchedTracingIncludes(
  tracingIncludes: Readonly<Record<string, readonly string[]>>,
  projectDir: string,
): { key: string; glob: string }[] {
  const empty: { key: string; glob: string }[] = [];
  for (const [key, globs] of Object.entries(tracingIncludes)) {
    for (const glob of globs) {
      const suffix = '/**';
      const isDirGlob = glob.endsWith(suffix);
      const target = resolve(projectDir, isDirGlob ? glob.slice(0, -suffix.length) : glob);
      const matches = isDirGlob
        ? existsSync(target) && statSync(target).isDirectory() && readdirSync(target).length > 0
        : existsSync(target);
      if (!matches) empty.push({ key, glob });
    }
  }
  return empty;
}

/**
 * The routes that read the dictionary but are not covered by any
 * `outputFileTracingIncludes` key — i.e. the ones that would 500 in production.
 */
export function untracedDictRoutes(
  routes: readonly ApiRoute[],
  tracingIncludes: Readonly<Record<string, readonly string[]>>,
  repoRoot: string,
): ApiRoute[] {
  const keys = Object.keys(tracingIncludes);
  return routes.filter(
    (route) =>
      readsDictionary(route, repoRoot) &&
      !keys.some((key) => tracingKeyMatches(key, route.path)),
  );
}
