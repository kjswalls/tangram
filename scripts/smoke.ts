/**
 * `pnpm smoke` — hit every API route of a **built, running** server over HTTP
 * and fail loudly on anything that is not 2xx.
 *
 * Why this exists rather than a unit test that calls the handlers: it catches
 * what only appears once the server is real — a route that throws at module
 * scope, a middleware that 401s something it should not, a page that fails to
 * render. None of that is visible from inside a handler call.
 *
 * What it does **not** catch is a missing `outputFileTracingIncludes` entry.
 * Every route is traced separately — even though Vercel then bundles them into
 * one shared function, whose file list is the union of those traces
 * (docs/deploy.md §5) — so a route that reads `data/dict.json` and is not listed
 * in `next.config.ts` ships with no claim on the file of its own, and is only
 * served by the group it landed in. No HTTP run can see that, here or against a
 * deployment: a local server reads `data/` off the disk either way. The guard is
 * static and lives in `tests/unit/server/routes.test.ts`, off the import graph.
 * `/api/examples` and `/api/recall` are the case in point — their keys were
 * added by hand at the Phase 8 merge, with nothing automated noticing.
 *
 * The coverage half of this script (`checkRouteCoverage`) is that guard's other
 * half: it refuses to let a route exist without a case here.
 *
 * It is a *smoke* test, not an assertion suite: every case sends a request a
 * healthy deployment must answer 2xx to. What the body says is
 * `tests/unit/**`'s job. The few checks here (`expect`) exist only to catch a
 * 200 that is not really an answer — an empty search, a handshake with no
 * provider.
 *
 * Run it against production too:
 *   export TANGRAM_ACCESS_SECRET=…      # once, if the deployment is gated
 *   pnpm smoke --base-url https://tangram.example.com
 *
 * The key can also be passed as `--key`, for the case where the variable is not
 * exported — but an argv value is readable from the process list and is recorded
 * in shell history, so the environment is the one to prefer.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NAV_ITEMS } from '../components/shell/nav';
import { ACCESS_COOKIE, COOKIE_SAFE_SECRET } from '../lib/server/access';
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
 *
 * The key may come from `--key` or from `$TANGRAM_ACCESS_SECRET`; the environment
 * is the one to prefer, because an argv value is readable from the process list
 * and is recorded in shell history.
 *
 * **A `--base-url` carrying `?key=` is disarmed, not passed through.** That URL is
 * exactly what `docs/deploy.md` tells the owner to visit to authorise a phone, so
 * it is the paste to expect — and `middleware.ts` goes to the trouble of
 * redirecting the key back out of the URL precisely so that it does not end up in
 * a history file or an access log. Concatenating it onto every request path would
 * put it in both. So the key is lifted out and used as the secret, and only the
 * origin survives. Throws for a base URL that is not a URL, or that carries a
 * path, query or fragment this script would otherwise silently mangle.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  let rawBaseURL =
    process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
  let secret = process.env.TANGRAM_ACCESS_SECRET;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url' && argv[i + 1]) rawBaseURL = argv[(i += 1)];
    else if (argv[i] === '--key' && argv[i + 1]) secret = argv[(i += 1)];
  }

  let url: URL;
  try {
    url = new URL(rawBaseURL);
  } catch {
    throw new Error(`--base-url is not a URL: ${rawBaseURL}`);
  }
  const embedded = url.searchParams.get('key');
  if (embedded) {
    // Deliberately overrides `--key`/the environment: whoever pasted the
    // authorisation URL meant that key, and this is the one place it is read.
    secret = embedded;
    url.searchParams.delete('key');
  }
  if (url.hash || url.search || (url.pathname !== '/' && url.pathname !== '')) {
    // Every caller builds `${base}${path}`, so a base with a path of its own
    // produces `/prefix/api/...` — or worse, `/?key=x/api/...`. Refuse rather
    // than guess.
    throw new Error(
      `--base-url must be an origin with no path, query or fragment — use ${url.origin}`,
    );
  }

  return { baseURL: url.origin, ...(secret ? { secret } : {}) };
}

/** What a key must be to be usable, and what to say when it is not. */
const UNUSABLE_KEY =
  'the key given is not usable as a cookie value (COOKIE_SAFE_SECRET, lib/server/access.ts) — check for a trailing newline or a space';

/**
 * The headers that authorise a request against a gated deployment, or none.
 *
 * The gate takes a cookie rather than a header (`lib/server/access.ts`): the
 * owner authorises a phone by visiting `?key=…` once, and a script has no
 * browser to do that in, so it sends the cookie the browser would have been
 * given. The secret goes into the request and nowhere else — never into a log
 * line, never into a URL, which is the whole reason the gate strips `?key=` in
 * the first place.
 *
 * **The shape is checked here, before `fetch` sees it.** `undici` rejects a header
 * value containing a newline by throwing `Headers.append: "tangram_access=…" is
 * an invalid header value` — with the value in the message, which both scripts then
 * print. That is not a hypothetical: `lib/server/access.ts` trims the secret
 * precisely because "Vercel's UI happily stores a variable whose value is a stray
 * newline", and that variable is where both scripts get their default key. So an
 * unusable key fails here, with a message that names the rule and never the value.
 */
export function accessHeaders(secret?: string): Record<string, string> {
  if (!secret) return {};
  if (!COOKIE_SAFE_SECRET.test(secret)) throw new Error(UNUSABLE_KEY);
  return { cookie: `${ACCESS_COOKIE}=${secret}` };
}

/**
 * Take the secret back out of a message before it is printed.
 *
 * Belt and braces behind `accessHeaders`: any message that reaches a console may
 * have been built by code that saw the key — a `fetch` rejection, a server echoing
 * a header back — and a CI log is forever. Costs one `split`/`join` on a failure
 * path.
 */
export function scrubSecret(message: string, secret?: string): string {
  return secret ? message.split(secret).join('<key>') : message;
}

async function main(): Promise<void> {
  let baseURL: string;
  let secret: string | undefined;
  try {
    ({ baseURL, secret } = parseArgs(process.argv.slice(2)));
    // Fail on an unusable key here, once, rather than 21 times inside the loop.
    accessHeaders(secret);
  } catch (error) {
    console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

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
    // Scrubbed: a failure line carries a thrown message, and a message about a
    // header can contain the header's value. Once per case, into CI logs.
    for (const failure of result.failures) console.error(`  FAIL ${scrubSecret(failure, secret)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`smoke: ${result.passed} routes ok`);
}

// Only when run as a script; the e2e suite imports `runSmoke` instead.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
