/**
 * `pnpm coldstart` — what a real session's first few seconds cost, and whether
 * the numbers mean anything.
 *
 *   pnpm coldstart --base-url https://tangram.example.com --key "$TANGRAM_ACCESS_SECRET"
 *
 * It replays the opening of a session against a deployed server: the banner's
 * `HEAD /api/dict/hsk?band=1` (the one request that starts the dictionary
 * warm-up, `lib/dict/warm.ts`), a two-second wait for `after()` to settle, then
 * the first lookup, the first search and the first reader paste — and then each
 * of those a second time, because "the second one is fast" is the claim the
 * warm-up is meant to make untrue for the first one as well.
 *
 * **The verdict is the instance id, not a latency band.** Latency alone cannot
 * tell a warmed instance from a cold one that happened to be asked something
 * cheap, and it certainly cannot tell you that two requests went to two
 * different processes — which is the failure this phase is guarding against,
 * since a warm-up only warms the process that ran it. Every dictionary response
 * carries `x-tangram-instance` (one `randomUUID()` per process) and
 * `x-tangram-index-parts` (`builtIndexParts()` at response time), so:
 *
 *   - one id across the whole sequence → one process answered everything, and
 *     the latencies below are a like-for-like series. That is what this
 *     deployment is expected to show: Vercel groups all eight route handlers
 *     into one function (docs/deploy.md §5).
 *   - more than one id → more than one function or more than one instance. The
 *     numbers are **not** comparable, and the first thing to check is whether a
 *     route has grown a `maxDuration` or `memory` export
 *     (`tests/unit/server/route-config.test.ts` is the local guard for that).
 *
 * Two deliberate omissions:
 *
 *   - `GET /api/ask` is not one of the samples: it reads no dictionary, so its
 *     latency says nothing about the warm-up. It is used once, before the
 *     sequence, as the gate check — it is the cheapest gated route, and because
 *     it touches no index it cannot perturb what the samples measure.
 *   - Nothing here prints the key. It goes into a cookie header via
 *     `accessHeaders()` and nowhere else.
 *
 * A non-2xx is an **invalid sample**, not a slow one: a 401 or a 503 is a
 * request that never did the work being timed, and averaging it in would be
 * inventing a number. Those runs exit non-zero.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DICT_INDEX_PARTS } from '../lib/dict/index';
import { INDEX_PARTS_HEADER, INSTANCE_HEADER } from '../lib/dict/diagnostics';
import { accessHeaders, parseArgs } from './smoke';

/**
 * How long to wait after the banner's probe answers.
 *
 * Two seconds is the plan's figure and it is one comfortable step past the
 * measured settling time: the warm-up needs ~1.3 s after the HEAD response
 * resolves on the build box (HANDOFF, Phase 9 cycle A). Short enough that the
 * probe still reports an unsettled warm-up if one regresses, rather than
 * sleeping until any implementation looks fine.
 */
const WARM_WAIT_MS = 2_000;

/** A cold dictionary load is seconds; a hung one should not be forever. */
const TIMEOUT_MS = 60_000;

/**
 * The entry the lookup samples ask for. Hard-coded rather than discovered from a
 * search first, because the order of the sequence is the point — `entries` has
 * to be the first dictionary request after the probe. If a CC-CEDICT snapshot
 * ever stops containing it the route still answers 200 with an empty list and
 * does the same index work, so the sample stays valid; the run says so.
 */
const SAMPLE_ENTRY_ID = '打算|打算[da3 suan4]';

/** The reader's first paste, in miniature. */
const SAMPLE_TEXT = '我们今天去北京';

export interface Step {
  /** What a reader of the output should understand this request to be. */
  name: string;
  method: 'GET' | 'HEAD' | 'POST';
  path: string;
  body?: unknown;
  /** Sleep this long before issuing it. */
  waitBeforeMs?: number;
}

export const SEQUENCE: Step[] = [
  // The app's very first request, from `components/shell/data-banner.tsx`.
  { name: 'banner HEAD hsk', method: 'HEAD', path: '/api/dict/hsk?band=1' },
  {
    name: 'first entries',
    method: 'GET',
    path: `/api/dict/entries?ids=${encodeURIComponent(SAMPLE_ENTRY_ID)}`,
    waitBeforeMs: WARM_WAIT_MS,
  },
  { name: 'first search', method: 'GET', path: '/api/dict/search?q=dasuan' },
  { name: 'first segment', method: 'POST', path: '/api/dict/segment', body: { text: SAMPLE_TEXT } },
  // The repeats: on a warm process these should be indistinguishable from the
  // firsts. A gap between a first and its repeat is the warm-up not having run.
  {
    name: 'repeat entries',
    method: 'GET',
    path: `/api/dict/entries?ids=${encodeURIComponent(SAMPLE_ENTRY_ID)}`,
  },
  { name: 'repeat search', method: 'GET', path: '/api/dict/search?q=dasuan' },
  { name: 'repeat segment', method: 'POST', path: '/api/dict/segment', body: { text: SAMPLE_TEXT } },
];

export interface Sample {
  step: Step;
  ms: number;
  status: number;
  /** `x-tangram-instance`, or null on a deployment that predates it. */
  instance: string | null;
  /** `x-tangram-index-parts`, split. Null when the header is absent. */
  parts: string[] | null;
  /** A one-line note about the body, when there is something to say. */
  note?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Read what a dictionary response says about itself. */
function diagnostics(response: Response): Pick<Sample, 'instance' | 'parts'> {
  const instance = response.headers.get(INSTANCE_HEADER);
  const raw = response.headers.get(INDEX_PARTS_HEADER);
  return { instance, parts: raw === null ? null : raw.split(',').filter(Boolean) };
}

async function issue(base: string, secret: string | undefined, step: Step): Promise<Sample> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...accessHeaders(secret),
  };
  if (step.body !== undefined) headers['content-type'] = 'application/json';

  const started = performance.now();
  try {
    const response = await fetch(`${base}${step.path}`, {
      method: step.method,
      headers,
      ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A gated deployment answers `?key=` with a 303; following it would time a
      // redirect chain instead of a dictionary request.
      redirect: 'manual',
    });
    // Timed to the last byte, not to the headers: the response body is part of
    // what a first lookup waits for.
    const text = step.method === 'HEAD' ? '' : await response.text();
    const ms = performance.now() - started;
    const sample: Sample = { step, ms, status: response.status, ...diagnostics(response) };
    const note = describeBody(step, response, text);
    return note ? { ...sample, note } : sample;
  } catch (error) {
    return {
      step,
      ms: performance.now() - started,
      status: 0,
      instance: null,
      parts: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The one thing worth saying about a body: that a 200 was empty.
 *
 * This is a probe, not an assertion suite (`pnpm smoke` is that), but a sample
 * whose answer contained nothing did less work than the same request against a
 * real answer, and a reader comparing two runs deserves to know.
 */
function describeBody(step: Step, response: Response, text: string): string | undefined {
  if (!response.ok || text === '') return undefined;
  try {
    const payload = JSON.parse(text) as {
      entries?: unknown[];
      groups?: unknown[];
      tokens?: unknown[];
    };
    if (step.path.startsWith('/api/dict/entries') && payload.entries?.length === 0) {
      return 'no entries — this snapshot does not contain the sample id';
    }
    if (step.path.startsWith('/api/dict/search') && payload.groups?.length === 0) {
      return 'no results for the sample query';
    }
    if (step.path.startsWith('/api/dict/segment') && payload.tokens?.length === 0) {
      return 'no tokens';
    }
  } catch {
    return 'body was not JSON';
  }
  return undefined;
}

/**
 * Is the deployment gated, and does what we hold open it?
 *
 * `GET /api/ask` is the cheapest of the three gated routes — a handshake that
 * names the provider and the prompt version, with no model call and no
 * dictionary read — so this costs nothing the samples care about.
 */
async function gateCheck(
  base: string,
  secret: string | undefined,
): Promise<{ ok: true; state: string } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/ask`, {
      method: 'GET',
      headers: { accept: 'application/json', ...accessHeaders(secret) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    return { ok: false, reason: `cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.status === 401) {
    return {
      ok: false,
      reason: secret
        ? 'the deployment refused the key given with --key (401)'
        : 'this deployment is gated — pass --key "$TANGRAM_ACCESS_SECRET"',
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `GET /api/ask answered ${response.status}; the server is not healthy` };
  }
  return { ok: true, state: secret ? 'gated, key accepted' : 'open (no gate, or none reached)' };
}

function formatSample(sample: Sample): string {
  const name = sample.step.name.padEnd(15);
  const where = `${sample.step.method} ${sample.step.path}`;
  const ms = `${sample.ms.toFixed(0)}ms`.padStart(8);
  if (sample.error) return `  ${name} ${ms}  FAILED  ${sample.error}`;
  const instance = sample.instance ? sample.instance.slice(0, 8) : '--------';
  const parts = sample.parts === null ? '(no header)' : sample.parts.join(',') || '(none built)';
  const flag = sample.status >= 200 && sample.status < 300 ? '' : '  INVALID SAMPLE';
  const note = sample.note ? `\n       note: ${sample.note}` : '';
  return `  ${name} ${ms}  ${sample.status}  ${instance}  ${parts}${flag}\n       ${where}${note}`;
}

export interface ProbeResult {
  samples: Sample[];
  /** Distinct instance ids seen, in first-seen order. */
  instances: string[];
  /** Samples that cannot be read as a measurement. */
  invalid: Sample[];
  /** True when at least one response carried no instance header at all. */
  missingHeaders: boolean;
}

export async function runProbe(
  baseURL: string,
  secret: string | undefined,
  log: (line: string) => void = () => {},
): Promise<ProbeResult> {
  const base = baseURL.replace(/\/$/, '');
  const samples: Sample[] = [];
  for (const step of SEQUENCE) {
    if (step.waitBeforeMs) {
      log(`  — waiting ${step.waitBeforeMs} ms for the warm-up to settle —`);
      await sleep(step.waitBeforeMs);
    }
    const sample = await issue(base, secret, step);
    samples.push(sample);
    log(formatSample(sample));
  }

  const instances: string[] = [];
  for (const sample of samples) {
    if (sample.instance && !instances.includes(sample.instance)) instances.push(sample.instance);
  }
  return {
    samples,
    instances,
    invalid: samples.filter((s) => s.error !== undefined || s.status < 200 || s.status >= 300),
    missingHeaders: samples.some((s) => s.error === undefined && s.instance === null),
  };
}

/** The verdict, as a line to print and an exit code. */
export function verdict(result: ProbeResult): { line: string; exitCode: number } {
  if (result.invalid.length > 0) {
    const names = result.invalid.map((s) => `${s.step.name} (${s.error ?? s.status})`).join(', ');
    return {
      line: `VERDICT invalid run — ${result.invalid.length} of ${result.samples.length} responses were not 2xx: ${names}. Nothing here is a measurement.`,
      exitCode: 1,
    };
  }
  if (result.instances.length === 0) {
    return {
      line: `VERDICT no ${INSTANCE_HEADER} on any response. This build predates the diagnostic headers (Phase 9), so the latencies above are all there is — they cannot be shown to come from one process.`,
      exitCode: 0,
    };
  }
  if (result.missingHeaders || result.instances.length > 1) {
    return {
      line: `VERDICT ${result.instances.length} instance ids across the sequence${result.missingHeaders ? ' (plus responses with no header at all)' : ''} — more than one function or instance answered, so these latencies are not comparable. Check for a maxDuration/memory export on a route, or for concurrent traffic scaling the deployment out.`,
      exitCode: 1,
    };
  }
  return {
    line: `VERDICT one process answered every request (${result.instances[0]}) — the latencies above are a like-for-like series.`,
    exitCode: 0,
  };
}

/** Did the warm-up finish during the wait? Read off the first post-wait sample. */
export function warmUpLine(result: ProbeResult): string {
  const afterWait = result.samples.find((s) => s.step.waitBeforeMs !== undefined);
  if (!afterWait || afterWait.parts === null) return 'warm-up: unknown (no parts header)';
  const built = afterWait.parts.length;
  const total = DICT_INDEX_PARTS.length;
  const missing = DICT_INDEX_PARTS.filter((part) => !afterWait.parts?.includes(part));
  return built >= total
    ? `warm-up: settled — all ${total} index parts built ${WARM_WAIT_MS} ms after the probe`
    : `warm-up: NOT settled — ${built}/${total} parts ${WARM_WAIT_MS} ms after the probe (missing ${missing.join(',')})`;
}

async function main(): Promise<void> {
  const { baseURL, secret } = parseArgs(process.argv.slice(2));
  console.log(`coldstart: ${baseURL}${secret ? ' (with access cookie)' : ''}`);

  const gate = await gateCheck(baseURL, secret);
  if (!gate.ok) {
    console.error(`coldstart: refusing to run — ${gate.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`coldstart: gate — ${gate.state}`);
  console.log(`  ${'step'.padEnd(15)} ${'latency'.padStart(8)}  code  instance  index parts`);

  const result = await runProbe(baseURL, secret, (line) => console.log(line));
  console.log(`coldstart: ${warmUpLine(result)}`);
  if (result.instances.length > 0) {
    console.log(`coldstart: instances — ${result.instances.join(', ')}`);
  }
  const { line, exitCode } = verdict(result);
  (exitCode === 0 ? console.log : console.error)(`coldstart: ${line}`);
  process.exitCode = exitCode;
}

// Only when run as a script, so a test can import the pieces above.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
