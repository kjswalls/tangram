/**
 * `pnpm smoke` — hit every API route of a **built, running** server over HTTP
 * and fail loudly on anything that is not 2xx.
 *
 * Why this exists rather than a unit test that calls the handlers: the two
 * failures this catches cannot be seen from inside the process.
 *
 *  1. **Missing `outputFileTracingIncludes`.** Every route is traced
 *     separately — even though Vercel then bundles them into one shared
 *     function, whose file list is the union of those traces (docs/deploy.md
 *     §5) — so a route that reads `data/dict.json` and is not listed in
 *     `next.config.ts` works in dev and 500s in the deployment.
 *     `/api/examples` and `/api/recall` shipped that way and were found by
 *     hand. The coverage half of this script (`checkRouteCoverage`) refuses to
 *     let a route exist without a case, and `tests/unit/server/tracing.test.ts`
 *     refuses to let a dictionary-reading route exist without a tracing entry.
 *  2. **Anything that only appears once the server is real**: a route that
 *     throws at module scope, a middleware that 401s something it should not, a
 *     page that fails to render.
 *
 * It is a *smoke* test, not an assertion suite: every case sends a request a
 * healthy deployment must answer 2xx to. What the body says is
 * `tests/unit/**`'s job. The few checks here (`expect`) exist only to catch a
 * 200 that is not really an answer — an empty search, a handshake with no
 * provider.
 *
 * Run it against production too:
 *   pnpm smoke --base-url https://tangram.example.com --key "$TANGRAM_ACCESS_SECRET"
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NAV_ITEMS } from '../components/shell/nav';
import { ACCESS_COOKIE } from '../lib/server/access';
import { discoverApiRoutes, type HttpMethod } from '../lib/server/route-inventory';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** Values one case hands to the next: real ids beat invented ones. */
export interface SmokeContext {
  entryId?: string;
}

export interface SmokeCase {
  /** What is being checked, in the failure message. */
  name: string;
  method: HttpMethod;
  /**
   * The route this case covers, exactly as `discoverApiRoutes` names it. Null
   * for a page or a static asset, which have no handler to cover.
   */
  route: string | null;
  /** Path plus query. `context` carries anything an earlier case captured. */
  url: (context: SmokeContext) => string;
  body?: (context: SmokeContext) => unknown;
  /** Optional: read the answer, and stash what later cases need. */
  expect?: (payload: unknown, context: SmokeContext) => void;
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * The cases. Ordered: the search runs first so everything downstream can use a
 * real entry id from *this* dictionary build rather than a hard-coded one that
 * a CC-CEDICT snapshot could quietly stop containing.
 */
export const SMOKE_CASES: SmokeCase[] = [
  {
    name: 'search finds a common word',
    method: 'GET',
    route: '/api/dict/search',
    url: () => `/api/dict/search?q=${encodeURIComponent('你好')}`,
    expect: (payload, context) => {
      const result = payload as { groups?: { entries?: { id?: string }[] }[] };
      const id = result.groups?.[0]?.entries?.[0]?.id;
      must(typeof id === 'string' && id.length > 0, 'search returned no entries');
      context.entryId = id;
    },
  },
  {
    name: 'entries answers for an id search just gave us',
    method: 'GET',
    route: '/api/dict/entries',
    url: (context) => `/api/dict/entries?ids=${encodeURIComponent(context.entryId as string)}`,
    expect: (payload) => {
      const result = payload as { entries?: unknown[] };
      must(result.entries?.length === 1, 'entries did not round-trip the id');
    },
  },
  {
    name: 'the HSK spine has a band 1',
    method: 'GET',
    route: '/api/dict/hsk',
    url: () => '/api/dict/hsk?band=1',
    expect: (payload) => {
      const result = payload as { entries?: unknown[] };
      must((result.entries?.length ?? 0) > 0, 'HSK band 1 came back empty');
    },
  },
  {
    // `components/shell/data-banner.tsx` probes with HEAD, and a HEAD that
    // 405s is a permanent "run pnpm data" banner over a working dictionary.
    name: 'the data banner’s HEAD probe',
    method: 'HEAD',
    route: '/api/dict/hsk',
    url: () => '/api/dict/hsk?band=1',
  },
  {
    name: 'decomposition (its own licence, its own file)',
    method: 'GET',
    route: '/api/dict/decomp',
    url: () => `/api/dict/decomp?chars=${encodeURIComponent('你好')}`,
    expect: (payload) => {
      const result = payload as { characters?: unknown[] };
      must((result.characters?.length ?? 0) > 0, 'decomp returned no characters');
    },
  },
  {
    name: 'segmentation of a sentence',
    method: 'POST',
    route: '/api/dict/segment',
    url: () => '/api/dict/segment',
    body: () => ({ text: '我们今天去北京' }),
    expect: (payload) => {
      const result = payload as { tokens?: unknown[] };
      must((result.tokens?.length ?? 0) > 0, 'segment returned no tokens');
    },
  },
  {
    name: 'ask handshake',
    method: 'GET',
    route: '/api/ask',
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
    url: () => '/api/examples',
    body: (context) => ({
      entryId: context.entryId,
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
    url: () => '/api/recall',
    body: (context) => ({ entryId: context.entryId, answer: 'hello' }),
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
 * Every nav route plus the three files the PWA cannot install without.
 *
 * The page list is **derived from `NAV_ITEMS`**, not copied from it. Phase 8
 * added `/stats` to the nav in another worktree and this list did not know:
 * a route reachable from the header but never requested by the smoke run is
 * exactly the page that 500s in production. Add a nav entry and it is smoked.
 */
export const PAGE_CASES: SmokeCase[] = [
  ...NAV_ITEMS.map((item) => item.href),
  '/offline.html',
  '/manifest.webmanifest',
  '/sw.js',
].map((path) => ({
  name: `page ${path}`,
  method: 'GET' as HttpMethod,
  route: null,
  url: () => path,
}));

/**
 * Every route handler in `app/api/**` has at least one case here.
 *
 * This is the half that survives the next person: a new route with no case
 * fails `pnpm smoke` and the e2e suite the day it is written, instead of
 * failing in production the day it is deployed.
 */
export function checkRouteCoverage(repoRoot: string = REPO_ROOT): string[] {
  const covered = new Set(
    SMOKE_CASES.filter((c) => c.route !== null).map((c) => `${c.method} ${c.route}`),
  );
  const missing: string[] = [];
  for (const route of discoverApiRoutes(repoRoot)) {
    if (route.methods.length === 0) {
      missing.push(`${route.relativeFile} exports no HTTP handler`);
      continue;
    }
    for (const method of route.methods) {
      if (!covered.has(`${method} ${route.path}`)) {
        missing.push(`${method} ${route.path} (${route.relativeFile}) has no case in SMOKE_CASES`);
      }
    }
  }
  return missing;
}

export interface SmokeOptions {
  baseURL: string;
  /** Sent as the access cookie; needed only against a gated deployment. */
  secret?: string | undefined;
  log?: (line: string) => void;
  /** Per-request timeout. A cold dictionary load is seconds, not milliseconds. */
  timeoutMs?: number;
}

export interface SmokeResult {
  passed: number;
  failures: string[];
  /** Wall time per case, slowest first — the cold-start numbers, for free. */
  timings: { name: string; ms: number }[];
}

/** Run every case against a running server. Never throws; report in the result. */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const log = options.log ?? (() => {});
  const timeout = options.timeoutMs ?? 60_000;
  const base = options.baseURL.replace(/\/$/, '');
  const context: SmokeContext = {};
  const failures: string[] = [];
  const timings: { name: string; ms: number }[] = [];
  let passed = 0;

  for (const smokeCase of [...SMOKE_CASES, ...PAGE_CASES]) {
    const started = Date.now();
    let url = '';
    try {
      url = `${base}${smokeCase.url(context)}`;
      const headers: Record<string, string> = {
        accept: 'application/json, text/html',
        ...accessHeaders(options.secret),
      };
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

      if (smokeCase.expect && smokeCase.method !== 'HEAD') {
        const type = response.headers.get('content-type') ?? '';
        const body = type.includes('json') ? await response.json() : await response.text();
        smokeCase.expect(body, context);
      }
      passed += 1;
      log(`  ok   ${String(ms).padStart(6)}ms  ${smokeCase.method} ${smokeCase.url(context)}`);
    } catch (error) {
      timings.push({ name: smokeCase.name, ms: Date.now() - started });
      failures.push(
        `${smokeCase.method} ${url || smokeCase.name} → ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { passed, failures, timings };
}

export interface CliArgs {
  baseURL: string;
  /** The access secret, when one was given. Never logged, never echoed. */
  secret?: string;
}

/**
 * `--base-url` and `--key`, with the same environment fallbacks, for every
 * script that talks to a running server.
 *
 * Exported because `scripts/coldstart-probe.ts` takes the same two arguments,
 * and two parsers for one pair of flags is two places for `--key` to be handled
 * differently — which for a credential is not a cosmetic difference.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  let baseURL =
    process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
  let secret = process.env.TANGRAM_ACCESS_SECRET;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url' && argv[i + 1]) baseURL = argv[(i += 1)];
    else if (argv[i] === '--key' && argv[i + 1]) secret = argv[(i += 1)];
  }
  return { baseURL, ...(secret ? { secret } : {}) };
}

/**
 * The headers that authorise a request against a gated deployment, or none.
 *
 * The gate takes a cookie rather than a header (`lib/server/access.ts`): the
 * owner authorises a phone by visiting `?key=…` once, and a script has no
 * browser to do that in, so it sends the cookie the browser would have been
 * given. The secret goes into the request and nowhere else — never into a log
 * line, never into a URL, which is the whole reason the gate strips `?key=` in
 * the first place.
 */
export function accessHeaders(secret?: string): Record<string, string> {
  return secret ? { cookie: `${ACCESS_COOKIE}=${secret}` } : {};
}

async function main(): Promise<void> {
  const { baseURL, secret } = parseArgs(process.argv.slice(2));

  const uncovered = checkRouteCoverage();
  if (uncovered.length > 0) {
    console.error('smoke: routes with no case (add one to SMOKE_CASES in scripts/smoke.ts):');
    for (const line of uncovered) console.error(`  - ${line}`);
    process.exitCode = 1;
    return;
  }

  console.log(`smoke: ${baseURL}${secret ? ' (with access cookie)' : ''}`);
  const result = await runSmoke({ baseURL, secret, log: (line) => console.log(line) });

  const slowest = [...result.timings].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(`smoke: slowest — ${slowest.map((t) => `${t.name} ${t.ms}ms`).join(' · ')}`);

  if (result.failures.length > 0) {
    console.error(`smoke: ${result.failures.length} failed, ${result.passed} passed`);
    for (const failure of result.failures) console.error(`  FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`smoke: ${result.passed} routes ok`);
}

// Only when run as a script; the e2e suite imports `runSmoke` instead.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
