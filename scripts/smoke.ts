/**
 * `pnpm smoke` — hit a **built, running** server over HTTP and fail loudly on
 * anything that is not what a healthy deployment answers.
 *
 * Why this exists rather than a unit test that calls the handlers: the failures
 * it catches cannot be seen from inside the process. A route that reads `data/`
 * and is not traced into its bundle works in dev and 500s in the deployment
 * (`/api/examples` and `/api/recall` both shipped that way and a human found
 * them); a host that is not applying `vercel.json` looks identical to one that
 * is until you read a response header; a build whose entry chunk did not make
 * it into `dist/` serves a 200 for every page and renders none of them.
 *
 * **It stays a dependency-free `tsx` CLI, and that is a decision** (W2).
 * `docs/deploy.md`'s after-deploy habit is `pnpm smoke --base-url https://… `,
 * run against production from wherever you happen to be; turning it into a
 * Playwright run would put a browser in the production checklist — in this
 * container only the pinned `/opt/pw-browsers/chromium`, with
 * `playwright install` forbidden. The assertions that genuinely need a rendered
 * DOM live in `tests/e2e/p0/routes.spec.ts` instead, and `tests/e2e/d/smoke.spec.ts`
 * imports `runSmoke` from here so the CLI and the suite can never drift.
 *
 * **What changed in W2, and why the page cases were not just kept.** Under the
 * SPA fallback every path that is not a real file returns 200 and `index.html`.
 * A status-only page case therefore passes against a build that renders
 * nothing, which is exactly what `web.md` R7 says. So a page case now asserts
 * that the served document is *this build's* document — it carries the same
 * module script the served `/` does — and the asset cases assert that script,
 * and every other emitted asset, is really there. Delete the entry chunk from
 * `dist/` and this fails; that is the whole point.
 *
 * Run it against production too:
 *   pnpm smoke --base-url https://tangram.example.com --key "$TANGRAM_ACCESS_SECRET"
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_FILE, type DictManifest } from '../apps/app/lib/dict/artifact';
import { ACCESS_HEADER } from '@tangram/access';
import {
  headersFor,
  readHostConfig,
  type HostConfig,
} from '../apps/app/lib/server/host-config';
import {
  discoverPageRoutes,
  pageRouteUrl,
  type HttpMethod,
} from '../apps/app/lib/server/route-inventory';
// The API routes are `apps/server`'s now (docs/plans/backend.md B1), and its
// route table is the single source of truth for them — `app.ts` mounts from it
// and `apps/server/src/smoke.ts` walks it. Reading the same table here is what
// keeps the coverage check below true after the move: until B1 it walked
// `app/api/**`, which no longer exists.
import { ROUTES as SERVER_ROUTES } from '../apps/server/src/routes/table.ts';
import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';

// The page-route table and the host config are the APP's; this script lives at
// the workspace root (docs/plans/wave-zero.md §1).
const REPO_ROOT = resolve(workspaceRoot(dirOf(import.meta.url)), 'apps/app');

/** Vite's build manifest, relative to `dist/`. Read off the installed Vite, not assumed. */
export const VITE_MANIFEST = '.vite/manifest.json';

/**
 * The entry id the two model-backed POSTs are exercised with.
 *
 * It used to come from the search case: `/api/dict/search?q=你好` ran first and
 * stashed a real id from *this* dictionary build, which is better than a
 * constant a CC-CEDICT snapshot could quietly stop containing. `data.md` D6
 * deleted that route, and there is no longer any HTTP endpoint that can answer
 * "give me an id" — the dictionary is on the client now.
 *
 * So it is a constant, and the trade is stated rather than hidden. 你好 is the
 * most stable headword in the corpus, and if it ever does leave, the failure is
 * loud and specific **without any help from this file**: `runSmoke` reports a
 * non-2xx as `POST <url> → 404 Not Found · <body>`, and the body is
 * `{"error":"entry-not-found","hint":"no dictionary entry with id …"}` — the
 * route names the id it could not find. The line to change is this one.
 *
 * (An earlier version of this comment promised a `must()` inside the two cases'
 * `expect` callbacks. It could never have run: `runSmoke` pushes a failure and
 * `continue`s on any non-2xx **before** `expect` is reached, so the guidance
 * would have been unreachable by construction. An adversarial reviewer caught
 * it; the guards are gone and this paragraph is what replaced them.)
 *
 * `backend.md` B2's contract puts retrieved entries on the wire, at which point
 * the smoke sends rows rather than an id and this goes.
 */
export const SMOKE_ENTRY_ID = '你好|你好[ni3 hao3]';

/** Values one case hands to the next: real ids beat invented ones. */
export interface SmokeContext {
  /**
   * An entry id one case found for the next. Unused since `data.md` D6 deleted
   * the search case that filled it — see `SMOKE_ENTRY_ID` — and left in place
   * because this file is `web.md` W2's and D6's licence there is to remove the
   * dictionary entries, not to reshape its types.
   */
  entryId?: string;
  /** The module script `/` served, e.g. `/assets/index-<hash>.js`. */
  entryScript?: string;
}

export interface SmokeCase {
  /** What is being checked, in the failure message. */
  name: string;
  method: HttpMethod;
  /**
   * The route this case covers, exactly as `apps/server/src/routes/table.ts`
   * names it. Null for a page or a static asset, which have no handler to
   * cover.
   */
  route: string | null;
  /** Path plus query. `context` carries anything an earlier case captured. */
  url: (context: SmokeContext) => string;
  body?: (context: SmokeContext) => unknown;
  /** True for the three routes the access gate covers; `--key` is sent only to those. */
  gated?: boolean;
  /** Sent against `--api-base` rather than `--base-url`. Every API case is. */
  api?: boolean;
  /** Optional: read the answer, and stash what later cases need. */
  expect?: (payload: unknown, context: SmokeContext) => void;
  /** Optional: read the response's headers and status. Runs before `expect`. */
  expectResponse?: (response: Response, context: SmokeContext) => void;
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * The API cases.
 *
 * `data.md` D6 removed the five dictionary cases with the routes they exercised;
 * `web.md` W2 owns this file and its final shape (wave-zero §3). The id the two
 * POSTs need is now `SMOKE_ENTRY_ID` rather than something an earlier case
 * stashed — see that constant for why, and for what happens when it goes stale.
 */
export const SMOKE_CASES: SmokeCase[] = [
  {
    name: 'ask handshake',
    method: 'GET',
    route: '/api/ask',
    api: true,
    gated: true,
    url: () => '/api/ask',
    expect: (payload) => {
      const result = payload as { provider?: string };
      must(Boolean(result.provider), 'the ask handshake named no provider');
    },
  },
  {
    name: 'a grounded ask',
    method: 'POST',
    route: '/api/ask',
    api: true,
    gated: true,
    url: () => '/api/ask',
    body: () => ({ query: '你好', profile: { estimatedBand: 1, knownSample: [] } }),
    expect: (payload) => {
      const result = payload as { response?: unknown; dictVersion?: string };
      must(Boolean(result.response), 'the ask answered without a response');
      must(Boolean(result.dictVersion), 'the ask answered without a dictionary version');
    },
  },
  {
    name: 'examples handshake',
    method: 'GET',
    route: '/api/examples',
    api: true,
    gated: true,
    url: () => '/api/examples',
    expect: (payload) => {
      const result = payload as { provider?: string };
      must(Boolean(result.provider), 'the examples handshake named no provider');
    },
  },
  {
    name: 'i+1 example sentences',
    method: 'POST',
    route: '/api/examples',
    api: true,
    gated: true,
    url: () => '/api/examples',
    body: () => ({
      entryId: SMOKE_ENTRY_ID,
      profile: { estimatedBand: 1, knownSample: [] },
      knownBand: 1,
    }),
    expect: (payload) => {
      const result = payload as { sentences?: unknown[] };
      must(Array.isArray(result.sentences), 'examples answered without a sentences array');
    },
  },
  {
    name: 'free-recall grading',
    method: 'POST',
    route: '/api/recall',
    api: true,
    gated: true,
    url: () => '/api/recall',
    body: () => ({ entryId: SMOKE_ENTRY_ID, answer: 'hello' }),
    expect: (payload) => {
      const result = payload as { suggested?: number };
      must(
        typeof result.suggested === 'number' && result.suggested >= 1 && result.suggested <= 4,
        'recall suggested something that is not a grade',
      );
    },
  },
];

/**
 * Every route `apps/server` declares that the app calls has a case here.
 *
 * This is the half that survives the next person: a new route with no case
 * fails `pnpm smoke` and the e2e suite the day it is written, instead of
 * failing in production the day it is deployed. `data.md` D6 removed the five
 * dictionary entries when it retired those routes; `backend.md` B1 moved the
 * three that are left to `apps/server`, so the question "what routes are there"
 * is answered by that package's table rather than by walking `app/api/**`,
 * which this app no longer has.
 *
 * **"Which routes does the app call" is the table's `gated` column, and writing
 * the three paths out as a literal here was a finding.** The first version of
 * this function filtered the table through `['/api/ask','/api/examples',
 * '/api/recall']`, and a reviewer pointed out that `backend.md` B2 adds
 * `/api/ask/propose` and `/api/ask/answer` — routes the app will certainly call
 * — which such a list would skip in silence, with `pnpm smoke` covering
 * neither, unless someone remembered to edit a literal. That is exactly the
 * drift `wave-zero.md` §5's ruling 2 legislates against ("a list in prose
 * drifts from the schema; `Exclude<StoreName, 'ask_cache'>` cannot").
 *
 * `gated` is the right derivation and not a coincidence: a route is gated
 * precisely when it reaches a paid model, which is precisely when the app is
 * the thing calling it. `/health` is the only ungated route and is deliberately
 * not covered here — `pnpm -F server smoke` walks the same table and probes
 * every route on it, including that one. This script's API cases exist to prove
 * the *app's* calls work against the deployed API, which is `docs/deploy.md`
 * §7's "the same run covers both halves".
 */
export function appCalledRoutes(): typeof SERVER_ROUTES {
  return SERVER_ROUTES.filter((route) => route.gated);
}

export function checkRouteCoverage(): string[] {
  const covered = new Set(
    SMOKE_CASES.filter((c) => c.route !== null).map((c) => `${c.method} ${c.route}`),
  );
  const missing: string[] = [];
  const called = appCalledRoutes();
  if (called.length === 0) {
    // A derivation that derives nothing is the vacuous-guard failure this file
    // exists to prevent, one level up.
    missing.push('apps/server declares no gated route; this coverage check would pass vacuously');
  }
  for (const route of called) {
    if (route.methods.length === 0) {
      missing.push(`${route.path} declares no method`);
      continue;
    }
    for (const method of route.methods) {
      if (!covered.has(`${method} ${route.path}`)) {
        missing.push(`${method} ${route.path} has no case in SMOKE_CASES`);
      }
    }
  }
  return missing;
}

/** `<script type="module" src="…">` — the entry Vite put in `index.html`. */
export function entryScriptOf(html: string): string | null {
  const match = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html);
  return match ? match[1] : null;
}

/**
 * The page cases, **derived** from `src/routes.tsx` rather than copied.
 *
 * Copying is what let `/stats` exist in the header and not in the smoke list
 * once already. Deriving also means `core.md` C7's collapse to three tabs costs
 * this file nothing — though somebody has to watch it pass, which is C7's
 * commit's job (`web.md` §2).
 */
export function pageCases(repoRoot: string = REPO_ROOT): SmokeCase[] {
  return discoverPageRoutes(repoRoot).map((route) => ({
    name: `page ${route.pattern}`,
    method: 'GET' as HttpMethod,
    route: null,
    url: () => pageRouteUrl(route),
    expectResponse: (response) => {
      const type = response.headers.get('content-type') ?? '';
      must(type.includes('text/html'), `${route.pattern} answered ${type}, not HTML`);
    },
    expect: (payload, context) => {
      const html = payload as string;
      const script = entryScriptOf(html);
      must(script !== null, `${route.pattern} served a document with no module script`);
      // Falsifiable, unlike a 200: the SPA fallback hands the same document to
      // every path, so the only thing worth asserting about it is that it is
      // THIS build's document — and `entryScript` is read from the LOCAL
      // `dist/.vite/manifest.json`, not from the served `/`. Comparing the
      // deployment against itself would pass for a build whose index.html
      // points at a chunk that is not there.
      must(
        script === context.entryScript,
        `${route.pattern} served ${script}; this build's entry is ${context.entryScript}`,
      );
    },
  }));
}

/** The three files the PWA cannot install without, plus the dictionary's two. */
export function staticCases(manifest: DictManifest | null): SmokeCase[] {
  const cases: SmokeCase[] = [
    { name: 'the offline page', path: '/offline.html' },
    { name: 'the web app manifest', path: '/manifest.webmanifest' },
    { name: 'the service worker', path: '/sw.js' },
  ].map(({ name, path }) => ({
    name,
    method: 'GET' as HttpMethod,
    route: null,
    url: () => path,
  }));

  if (manifest) {
    cases.push(
      {
        name: `the dictionary artifact (${manifest.file})`,
        method: 'GET',
        route: null,
        url: () => `/${manifest.file}`,
        expectResponse: (response) => {
          const length = Number(response.headers.get('content-length') ?? '0');
          const encoding = response.headers.get('content-encoding');
          // Not an equality check against `manifest.bytes`: the whole point of
          // the `.br` rule is that a negotiated response is SHORTER than the
          // artifact. What must be true either way is that something real is
          // being served, and that an encoded one is smaller than the raw file.
          must(length > 0, 'the artifact answered with no content-length');
          if (encoding === null) {
            must(
              length === manifest.bytes,
              `the artifact is ${length} bytes; the manifest says ${manifest.bytes}`,
            );
          } else {
            must(
              length < manifest.bytes,
              `content-encoding: ${encoding} but ${length} bytes ≥ the raw ${manifest.bytes}`,
            );
          }
        },
      },
      {
        name: `the brotli sibling (${manifest.file}.br)`,
        method: 'GET',
        route: null,
        url: () => `/${manifest.file}${'.br'}`,
        expectResponse: (response) => {
          // Served under its own name with `content-encoding: br`, so a client
          // that asks for it gets the artifact's bytes transparently decoded.
          // NOT content negotiation on the canonical path: Vercel consults
          // rewrites only after the filesystem and the `.sqlite` is a real
          // file, so the rewrite could never fire while the paired header
          // still would — 43 MB of raw SQLite labelled brotli.
          const encoding = response.headers.get('content-encoding');
          must(
            encoding === 'br',
            `the sibling answered content-encoding: ${encoding ?? '(none)'}`,
          );
        },
        expect: () => {},
      },
      {
        name: 'the dictionary manifest',
        method: 'GET',
        route: null,
        url: () => `/${MANIFEST_FILE}`,
        expect: (payload) => {
          const served = payload as DictManifest;
          must(
            served.file === manifest.file && served.sha256 === manifest.sha256,
            `the served ${MANIFEST_FILE} names ${served.file}, the local one ${manifest.file}`,
          );
        },
      },
      {
        name: 'the decomposition file',
        method: 'GET',
        route: null,
        url: () => '/decomp.json',
      },
    );
  }
  return cases;
}

/**
 * What an extension must come back as.
 *
 * **This is the assertion, not the 200.** A host with a careless catch-all —
 * and `vite preview` is exactly that, answering a missing `/assets/<hash>.js`
 * with 200 `index.html` — makes a status-only asset check unfalsifiable in the
 * same way a status-only page check is. It was tried: a build with its entry
 * chunk deleted passed every case. A `.js` that arrives as `text/html` is the
 * shape of that failure and is what this catches, on any host.
 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.css': 'text/css',
};

/**
 * The entry script **this build** emitted, read out of Vite's manifest.
 *
 * The page cases used to compare each served document against the served `/`.
 * Both sides came from the deployment, so the check proved only that every path
 * returns the same document — which the SPA fallback guarantees by
 * construction, and which is true of a `dist/` whose `index.html` points at a
 * chunk that is not there. Anchoring to the local manifest is what makes it an
 * assertion about the build rather than about the host's self-consistency.
 */
export function manifestEntryScript(distDir: string): string | null {
  const path = resolve(distDir, VITE_MANIFEST);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    { file?: string; isEntry?: boolean }
  >;
  for (const chunk of Object.values(manifest)) {
    if (chunk.isEntry && chunk.file) return `/${chunk.file}`;
  }
  return null;
}

/** Every hashed asset Vite emitted, read out of its own build manifest. */
export function assetCases(distDir: string): SmokeCase[] {
  const path = resolve(distDir, VITE_MANIFEST);
  if (!existsSync(path)) return [];
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    { file?: string; css?: string[] }
  >;
  const files = new Set<string>();
  for (const chunk of Object.values(manifest)) {
    if (chunk.file) files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
  }
  return [...files].sort().map((file) => {
    const extension = /\.[a-z]+$/.exec(file)?.[0] ?? '';
    const expected = ASSET_CONTENT_TYPES[extension];
    return {
      name: `asset ${file}`,
      method: 'GET' as HttpMethod,
      route: null,
      url: () => `/${file}`,
      expectResponse: (response: Response) => {
        const type = (response.headers.get('content-type') ?? '').toLowerCase();
        must(
          !type.includes('text/html'),
          `/${file} came back as HTML — the file is missing and something answered the SPA fallback for it`,
        );
        if (expected) {
          must(type.includes(expected), `/${file} came back as ${type || '(no type)'}`);
        }
      },
    };
  });
}

export interface SmokeOptions {
  baseURL: string;
  /** Where the API lives. Same origin until `web.md` W4 configures one. */
  apiBaseURL?: string;
  /**
   * Skip the API cases entirely.
   *
   * `docs/deploy.md`'s after-deploy command runs against the STATIC deployment,
   * which has no `/api/**` at all until `backend.md` ships a server — the SPA
   * fallback deliberately excludes `/api/` so those paths 404. Without this the
   * documented checklist command fails by construction on a healthy
   * deployment, which is how a red smoke stops meaning anything.
   */
  skipApi?: boolean;
  /**
   * Sent as `X-Tangram-Access` to the gated routes only; needed only against a
   * gated deployment. Gated-only rather than everywhere because a credential
   * that travels to routes that do not need it is a credential in more logs.
   */
  secret?: string | undefined;
  /** `apps/app/dist`, for the build manifest. */
  distDir?: string;
  /** `apps/app`, for the route table, the API inventory and `vercel.json`. */
  repoRoot?: string;
  /** Where `pnpm data` wrote, for the artifact's identity. */
  dataDir?: string;
  log?: (line: string) => void;
  /** Per-request timeout. A cold dictionary load is seconds, not milliseconds. */
  timeoutMs?: number;
}

export interface SmokeResult {
  passed: number;
  failures: string[];
  /** Wall time per case, slowest first — the cold-start numbers, for free. */
  timings: { name: string; ms: number }[];
  /** How many hashed assets were checked. Zero means there was no build manifest. */
  assetsChecked: number;
  /** How many paths had their `vercel.json` headers asserted. */
  hostRulesChecked: number;
  /** API cases not run because `--no-api` was passed. */
  apiSkipped: number;
  /** Dictionary cases not run because the local `data/` has no manifest. */
  dictSkipped: boolean;
}

function readDictManifest(dataDir: string): DictManifest | null {
  const path = resolve(dataDir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DictManifest;
  } catch {
    return null;
  }
}

function readConfig(repoRoot: string): HostConfig | null {
  try {
    return readHostConfig(repoRoot);
  } catch {
    return null;
  }
}

/**
 * The headers `vercel.json` says this path must carry, checked against what
 * arrived.
 *
 * `content-encoding` is deliberately **not** asserted. A correct host may
 * answer a `.br`-negotiated request either way and both are fine; what would be
 * wrong is the *other* direction, an encoding claimed over unencoded bytes, and
 * the artifact case's length check is what catches that.
 */
const UNASSERTED_HEADERS = new Set(['content-encoding', 'vary']);

function checkHostRules(
  config: HostConfig,
  pathname: string,
  requestHeaders: Record<string, string>,
  response: Response,
): string[] {
  const expected = headersFor(config, { pathname, headers: requestHeaders });
  const wrong: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (UNASSERTED_HEADERS.has(key)) continue;
    const actual = response.headers.get(key);
    if (actual === null || actual.toLowerCase() !== value.toLowerCase()) {
      wrong.push(`${pathname}: ${key} is ${actual ?? '(absent)'}, vercel.json says ${value}`);
    }
  }
  return wrong;
}

/** Run every case against a running server. Never throws; report in the result. */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const log = options.log ?? (() => {});
  const timeout = options.timeoutMs ?? 60_000;
  const base = options.baseURL.replace(/\/$/, '');
  const apiBase = (options.apiBaseURL ?? options.baseURL).replace(/\/$/, '');
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const distDir = options.distDir ?? resolve(repoRoot, 'dist');
  const dataDir = options.dataDir ?? resolve(repoRoot, '..', '..', 'data');

  const config = readConfig(repoRoot);
  const dictManifest = readDictManifest(dataDir);
  const assets = assetCases(distDir);
  const context: SmokeContext = {};
  const failures: string[] = [];
  const timings: { name: string; ms: number }[] = [];
  let passed = 0;
  let hostRulesChecked = 0;

  // `/` first and on its own: every page case compares its document against
  // this one's, and the asset cases are only meaningful once something has
  // said which script the build actually references.
  const apiCases = options.skipApi ? [] : SMOKE_CASES;
  const cases = [
    ...assets,
    ...staticCases(dictManifest),
    ...apiCases,
    ...pageCases(repoRoot),
  ];

  const entry = manifestEntryScript(distDir);
  if (entry === null) {
    // No local build to anchor against; fall back to the served `/`, which is
    // weaker and says so in the CLI's own warning line.
    const root = await fetchRoot(base, timeout);
    if (root instanceof Error) {
      failures.push(`GET ${base}/ → ${root.message}`);
      return {
        passed,
        failures,
        timings,
        assetsChecked: 0,
        hostRulesChecked,
        apiSkipped: apiCases.length === 0 ? SMOKE_CASES.length : 0,
        dictSkipped: dictManifest === null,
      };
    }
    context.entryScript = root;
  } else {
    context.entryScript = entry;
  }

  for (const smokeCase of cases) {
    const started = Date.now();
    let url = '';
    try {
      const origin = smokeCase.api ? apiBase : base;
      const path = smokeCase.url(context);
      url = `${origin}${path}`;
      const headers: Record<string, string> = { accept: 'application/json, text/html' };
      // The artifact is the one thing worth asking for compressed: the `.br`
      // rule exists or it does not, and only a request that says `br` finds out.
      headers['accept-encoding'] = 'br, gzip';
      // The credential is `X-Tangram-Access` (docs/plans/web.md W4), the same
      // header the app attaches. It went on being a cookie here for two phases
      // after the cookie stopped existing, which would have made
      // `pnpm smoke --key` 401 everything against a gated deployment — the one
      // command `docs/deploy.md`'s checklist runs there.
      if (options.secret && smokeCase.gated) headers[ACCESS_HEADER] = options.secret;
      let payload: BodyInit | undefined;
      if (smokeCase.body) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(smokeCase.body(context));
      }
      const response = await fetch(url, {
        method: smokeCase.method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(timeout),
        redirect: 'manual',
      });
      const ms = Date.now() - started;
      timings.push({ name: smokeCase.name, ms });

      if (!response.ok) {
        // The body of a failure is the most useful thing on the screen, and it
        // is a *failure* body — never a successful one, which could be large.
        const text = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
        failures.push(
          `${smokeCase.method} ${url} → ${response.status} ${response.statusText} · ${text}`,
        );
        continue;
      }

      if (config && !smokeCase.api) {
        const pathname = path.split('?')[0];
        const expected = headersFor(config, { pathname, headers });
        if (Object.keys(expected).length > 0) hostRulesChecked += 1;
        const wrong = checkHostRules(config, pathname, headers, response);
        if (wrong.length > 0) {
          failures.push(...wrong);
          await response.arrayBuffer();
          continue;
        }
      }

      smokeCase.expectResponse?.(response, context);
      if (smokeCase.expect && smokeCase.method !== 'HEAD') {
        const type = response.headers.get('content-type') ?? '';
        const body = type.includes('json') ? await response.json() : await response.text();
        smokeCase.expect(body, context);
      } else {
        // Drain, so a 43 MB artifact is not left holding the connection open.
        await response.arrayBuffer();
      }
      passed += 1;
      log(`  ok   ${String(ms).padStart(6)}ms  ${smokeCase.method} ${path}`);
    } catch (error) {
      timings.push({ name: smokeCase.name, ms: Date.now() - started });
      failures.push(
        `${smokeCase.method} ${url || smokeCase.name} → ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    passed,
    failures,
    timings,
    assetsChecked: assets.length,
    hostRulesChecked,
    apiSkipped: options.skipApi ? SMOKE_CASES.length : 0,
    dictSkipped: dictManifest === null,
  };
}

/** The served `/`, reduced to the one fact every page case compares against. */
async function fetchRoot(base: string, timeout: number): Promise<string | Error> {
  try {
    const response = await fetch(`${base}/`, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual',
    });
    if (!response.ok) return new Error(`${response.status} ${response.statusText}`);
    const script = entryScriptOf(await response.text());
    if (script === null) return new Error('the served / has no module script');
    return script;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function parseArgs(argv: readonly string[]): {
  baseURL: string;
  apiBaseURL?: string;
  secret?: string;
  skipApi: boolean;
} {
  let baseURL = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
  let apiBaseURL = process.env.TANGRAM_API_BASE;
  let secret = process.env.TANGRAM_ACCESS_SECRET;
  let skipApi = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url' && argv[i + 1]) baseURL = argv[(i += 1)];
    else if (argv[i] === '--api-base' && argv[i + 1]) apiBaseURL = argv[(i += 1)];
    else if (argv[i] === '--key' && argv[i + 1]) secret = argv[(i += 1)];
    else if (argv[i] === '--no-api') skipApi = true;
  }
  return {
    baseURL,
    skipApi,
    ...(apiBaseURL ? { apiBaseURL } : {}),
    ...(secret ? { secret } : {}),
  };
}

async function main(): Promise<void> {
  const { baseURL, apiBaseURL, secret, skipApi } = parseArgs(process.argv.slice(2));

  // **Neither flag is not a default; it is a mistake with a confusing failure.**
  // Until `backend.md` B1 the app's own origin answered `/api/**` — the preview
  // adapter mounted the handlers there — so `apiBaseURL` falling back to
  // `baseURL` was right. It is now an origin that serves no API at all
  // (`vercel.json`'s fallback deliberately excludes `/api/`), so the fallback
  // would report five 404s that look like a broken deployment and are really a
  // missing argument. Say which one.
  if (!skipApi && apiBaseURL === undefined) {
    console.error(
      'smoke: pass --api-base <url> (the apps/server origin), or --no-api if there is no server\n' +
        '  to point at yet. The three model routes left this app in backend.md B1, so its own\n' +
        '  origin answers 404 for every /api/** path — see docs/deploy.md §7.',
    );
    process.exitCode = 2;
    return;
  }

  const uncovered = skipApi ? [] : checkRouteCoverage();
  if (uncovered.length > 0) {
    console.error('smoke: routes with no case (add one to SMOKE_CASES in scripts/smoke.ts):');
    for (const line of uncovered) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `smoke: ${baseURL}${apiBaseURL ? ` (api ${apiBaseURL})` : ''}${secret ? ' (with a key)' : ''}`,
  );
  const result = await runSmoke({
    baseURL,
    skipApi,
    ...(apiBaseURL ? { apiBaseURL } : {}),
    secret,
    log: (line) => console.log(line),
  });

  // Loud, and not failures: every one of these is "run from a tree that is not
  // the one that was deployed". Silence would turn each into a claim nobody
  // checked — which is the shape of the page cases W2 was written to fix.
  if (result.assetsChecked === 0) {
    console.warn(
      `smoke: no ${VITE_MANIFEST} — the hashed assets were NOT checked, and the page ` +
        'cases fell back to comparing the deployment against itself. Run pnpm build first.',
    );
  }
  if (result.dictSkipped) {
    console.warn(
      `smoke: no ${MANIFEST_FILE} in the local data/ — the artifact, its brotli sibling, ` +
        'the manifest and decomp.json were NOT checked, and neither were host rules 4 and 5. ' +
        'Run pnpm data first.',
    );
  }
  if (result.apiSkipped > 0) {
    console.warn(`smoke: --no-api — ${result.apiSkipped} API cases were NOT run.`);
  }

  const slowest = [...result.timings].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(`smoke: slowest — ${slowest.map((t) => `${t.name} ${t.ms}ms`).join(' · ')}`);

  if (result.failures.length > 0) {
    console.error(`smoke: ${result.failures.length} failed, ${result.passed} passed`);
    for (const failure of result.failures) console.error(`  FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `smoke: ${result.passed} ok — ${result.assetsChecked} assets, ` +
      `${result.hostRulesChecked} paths with host rules` +
      `${result.apiSkipped > 0 ? `, ${result.apiSkipped} API cases skipped` : ''}`,
  );
}

// Only when run as a script; the e2e suite imports `runSmoke` instead.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
