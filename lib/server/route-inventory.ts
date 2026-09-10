/**
 * What routes this app has, what they import, and whether the build is
 * configured to ship them the files they read.
 *
 * This exists because of one production-only failure mode. `data/dict.json` is
 * read from disk at request time, and on Vercel every route's files are traced
 * **separately** — even though the routes are then bundled into one shared
 * function, whose file list is the union of those traces (docs/deploy.md §5). A
 * route that reaches `lib/dict/load.ts` but is missing from
 * `outputFileTracingIncludes` in `next.config.ts` works perfectly under
 * `next dev` and under `pnpm start` — the file is simply on disk in both — and in
 * the deployment it is leaning on a route it happens to be grouped with having
 * declared the same files. `/api/examples` and `/api/recall` were exactly that,
 * and it took someone opening the page to notice.
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
