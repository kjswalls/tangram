/**
 * `pnpm coldstart` — what a real session's first few seconds cost, and whether
 * the numbers mean anything.
 *
 *   export TANGRAM_ACCESS_SECRET=…      # once, if the deployment is gated
 *   pnpm coldstart --base-url https://tangram.example.com
 *
 * It replays the opening of a session against a deployed server: the banner's
 * `HEAD /api/dict/hsk?band=1` (the one request that starts the dictionary
 * warm-up, `lib/dict/warm.ts`), a two-second wait for `after()` to settle, then
 * the first lookup, the first search and the first reader paste — and then each
 * of those a second time, because "the second one is fast" is the claim the
 * warm-up is meant to make untrue for the first one as well.
 *
 * **It only measures anything against an instance nothing has touched yet.** The
 * subject is a *cold* start, so any earlier request — `pnpm smoke`, a browser
 * opening the app, a health check — has already paid the bill this run exists to
 * watch being paid, and every number below would then be a warm number wearing a
 * cold run's labels. That failure is silent from latency alone, so the probe
 * detects it (`preWarmReason`) and refuses the run rather than printing a verdict
 * somebody could quote.
 *
 * **The verdict is the instance id, not a latency band.** Latency alone cannot
 * tell a warmed instance from a cold one that happened to be asked something
 * cheap, and it certainly cannot tell you that two requests went to two
 * different processes — which is the failure this phase is guarding against,
 * since a warm-up only warms the process that ran it. Every dictionary response
 * carries `x-tangram-instance` (one `randomUUID()` per process),
 * `x-tangram-index-parts` (`builtIndexParts()` at response time) and
 * `x-tangram-dict-warm` (`dictionaryWarm()` — the parts *and* the two caches
 * outside that vocabulary), so:
 *
 *   - one id across the whole sequence → one process answered everything, and
 *     the latencies below are a like-for-like series. That is what the five
 *     *dictionary* routes are expected to show: Vercel groups route handlers
 *     whose config matches into one function (docs/deploy.md §5), and on this app
 *     that is all eight — but only the dictionary routes carry the headers, so
 *     what this script observes is four of the eight. The verdict says so.
 *   - more than one id → more than one function or more than one instance. The
 *     numbers are **not** comparable, and the first thing to check is whether a
 *     route has grown a `maxDuration`, `memory`, `runtime` or `preferredRegion`
 *     export (`tests/unit/server/route-config.test.ts` is the local guard).
 *   - `x-tangram-dict-warm: no` after the wait → the warm-up did not finish, even
 *     if all six parts are listed. The two caches it also builds are invisible to
 *     the parts header by construction, so "all six parts" is not the same claim.
 *
 * Two deliberate omissions:
 *
 *   - `GET /api/ask` is not one of the samples: it reads no dictionary, so its
 *     latency says nothing about the warm-up. It is used once, before the
 *     sequence, as the gate check — it is the cheapest gated route, and because
 *     it touches no index it cannot perturb what the samples measure. (It *is* a
 *     request, so "no request issued" is never true of a refusal; what is true is
 *     that no dictionary sample was issued.)
 *   - Nothing here prints the key. It goes into a cookie header via
 *     `accessHeaders()` and nowhere else, `parseArgs()` lifts a `?key=` out of a
 *     pasted `--base-url` before it can be printed or re-sent, and the two places
 *     that print an error message scrub the secret out of it first — because a
 *     key that `fetch` refuses (a stray newline is the case the gate itself
 *     anticipates) puts its own value in the thrown message. Prefer exporting
 *     `TANGRAM_ACCESS_SECRET` to passing `--key`: an argv value is readable from
 *     the process list and is recorded in shell history.
 *
 * A non-2xx is an **invalid sample**, not a slow one: a 401 or a 503 is a
 * request that never did the work being timed, and averaging it in would be
 * inventing a number. Those runs exit non-zero.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DICT_INDEX_PARTS } from '../lib/dict/index';
import { DICT_WARM_HEADER, INDEX_PARTS_HEADER, INSTANCE_HEADER } from '../lib/dict/diagnostics';
import { DICT_WARM_CACHES } from '../lib/dict/warm';
import { accessHeaders, parseArgs, scrubSecret } from './smoke';

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
  /** `x-tangram-dict-warm` as a boolean. Null when the header is absent. */
  warm: boolean | null;
  /** A one-line note about the body, when there is something to say. */
  note?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Read what a dictionary response says about itself. */
function diagnostics(response: Response): Pick<Sample, 'instance' | 'parts' | 'warm'> {
  const instance = response.headers.get(INSTANCE_HEADER);
  const raw = response.headers.get(INDEX_PARTS_HEADER);
  const warm = response.headers.get(DICT_WARM_HEADER);
  return {
    instance,
    parts: raw === null ? null : raw.split(',').filter(Boolean),
    // Anything that is not the literal `yes` is read as not-warm, so a future
    // spelling can only ever make the probe more sceptical, never less.
    warm: warm === null ? null : warm === 'yes',
  };
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
      warm: null,
      // Scrubbed: a key `fetch` refuses to put in a header comes back inside the
      // thrown message, and this string is printed.
      error: scrubSecret(error instanceof Error ? error.message : String(error), secret),
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
    // Scrubbed before it is printed: an unusable key (a stray newline is the case
    // `lib/server/access.ts` trims for) makes `fetch` throw a message containing
    // the value it refused.
    const detail = scrubSecret(error instanceof Error ? error.message : String(error), secret);
    return { ok: false, reason: `cannot reach ${base}: ${detail}` };
  }
  if (response.status === 401) {
    return {
      ok: false,
      reason: secret
        ? 'the deployment refused the key it was given (401)'
        : 'this deployment is gated — export TANGRAM_ACCESS_SECRET, or pass --key',
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `GET /api/ask answered ${response.status}; the server is not healthy` };
  }
  // Not "gated, key accepted": a 200 to a request carrying a cookie says the key
  // was not *refused*, which is also what an ungated deployment answers.
  return {
    ok: true,
    state: secret ? 'a key was sent and not refused' : 'open (no gate, or none reached)',
  };
}

function formatSample(sample: Sample): string {
  const name = sample.step.name.padEnd(15);
  const where = `${sample.step.method} ${sample.step.path}`;
  const ms = `${sample.ms.toFixed(0)}ms`.padStart(8);
  if (sample.error) return `  ${name} ${ms}  FAILED  ${sample.error}`;
  const instance = sample.instance ? sample.instance.slice(0, 8) : '--------';
  const parts = sample.parts === null ? '(no header)' : sample.parts.join(',') || '(none built)';
  // Printed next to the parts because the whole point is that they can disagree.
  const warm = sample.warm === null ? '' : ` warm=${sample.warm ? 'yes' : 'no'}`;
  const flag = sample.status >= 200 && sample.status < 300 ? '' : '  INVALID SAMPLE';
  const note = sample.note ? `\n       note: ${sample.note}` : '';
  return `  ${name} ${ms}  ${sample.status}  ${instance}  ${parts}${warm}${flag}\n       ${where}${note}`;
}

export interface ProbeResult {
  samples: Sample[];
  /** Distinct instance ids seen, in first-seen order. */
  instances: string[];
  /** Samples that cannot be read as a measurement. */
  invalid: Sample[];
  /** True when at least one response carried no instance header at all. */
  missingHeaders: boolean;
  /**
   * Why this run cannot be read as a cold start, or null when it can. See
   * `preWarmReason`.
   */
  preWarm: string | null;
}

/**
 * Below this, the banner's HEAD cannot have parsed `data/dict.json`.
 *
 * A cold HEAD is a 33 MB `JSON.parse` plus three index parts: measured 622–741 ms
 * on the build box, and slower on a Vercel instance. A warm one is 8–12 ms. The
 * threshold sits an order of magnitude above the warm figure and an order of
 * magnitude below the cold one, so the only way to land in between is a network
 * that added ~100 ms of its own — which pushes the reading towards "cold", the
 * safe direction: a genuinely cold run is never suppressed, and the worst case is
 * that an already-warm instance over a slow link is not caught by *this* signal.
 * The parts signal catches that one.
 */
const COLD_HEAD_FLOOR_MS = 100;

/**
 * Was this instance already warm when the probe arrived — i.e. did the run
 * measure nothing?
 *
 * The probe's whole premise is that the banner's HEAD is the first request this
 * process has seen. If something touched it first — `pnpm smoke`, a browser, a
 * health check, or simply a second run of this script — then the parse and the
 * indexes were paid by that request instead, every sample below is a warm number,
 * and the closing lines are byte-identical to a real cold run. Two independent
 * tells, either of which is conclusive:
 *
 *  - **The HEAD already listed every index part.** A cold HEAD builds exactly
 *    `sorted`, `entries`, `hsk`; the other three arrive later, in `after()`. So a
 *    HEAD stamped with all six was answered by a process that had already been
 *    warmed.
 *  - **The HEAD answered too fast to have parsed the dictionary.** This catches
 *    the partial case the parts list cannot: a process that has served one
 *    `GET /api/dict/entries` has paid the ~650 ms parse and still reports three
 *    parts, so its HEAD looks cold in the header and takes 12 ms.
 */
export function preWarmReason(samples: readonly Sample[]): string | null {
  const head = samples[0];
  // Nothing to say about a request that failed or was refused; `invalid` owns it.
  if (!head || head.error !== undefined || head.status < 200 || head.status >= 300) return null;
  if (head.parts !== null && DICT_INDEX_PARTS.every((part) => head.parts?.includes(part))) {
    return `the banner's HEAD already carried all ${DICT_INDEX_PARTS.length} index parts, which a cold process cannot do — it builds three and schedules the rest`;
  }
  if (head.ms < COLD_HEAD_FLOOR_MS) {
    return `the banner's HEAD answered in ${head.ms.toFixed(0)} ms, far under the ~0.6–1 s a cold dict.json parse costs`;
  }
  return null;
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
    preWarm: preWarmReason(samples),
  };
}

export interface VerdictOptions {
  /**
   * Accept a run in which no response carried the diagnostic headers.
   *
   * There is one legitimate case — the comparison run against the *previous*
   * deploy, which the plan's acceptance asks for and which has no headers at all
   * — and it is a deliberate act, so it takes a flag. Without it an unstamped run
   * fails: a deployment that lost the headers for any other reason (the wrapper
   * removed, a proxy stripping `x-tangram-*`) would otherwise report as a
   * legitimate historical run, and the release gate would stay green while the
   * only outside evidence this phase produces had gone.
   */
  allowUnstamped?: boolean;
}

/** The verdict, as a line to print and an exit code. */
export function verdict(result: ProbeResult, options: VerdictOptions = {}): {
  line: string;
  exitCode: number;
} {
  if (result.invalid.length > 0) {
    const names = result.invalid.map((s) => `${s.step.name} (${s.error ?? s.status})`).join(', ');
    return {
      line: `VERDICT invalid run — ${result.invalid.length} of ${result.samples.length} responses were not 2xx: ${names}. Nothing here is a measurement.`,
      exitCode: 1,
    };
  }
  // Before every header-shaped verdict below: if the instance was already warm,
  // the ids and the parts are all perfectly consistent and all beside the point.
  if (result.preWarm !== null) {
    return {
      line: `VERDICT this instance was already warm before the probe ran — ${result.preWarm}. This run measures nothing about a cold start; the numbers above are warm-path numbers. Re-run against a deployment nothing has touched since it was built (§5 of docs/deploy.md), before pnpm smoke rather than after it.`,
      exitCode: 1,
    };
  }
  if (result.instances.length === 0) {
    const line = `VERDICT no ${INSTANCE_HEADER} on any response. Either this build predates the diagnostic headers (Phase 9) — which is the expected answer from the previous-deploy comparison run — or something between here and the handler is stripping x-tangram-*. Either way the latencies above cannot be shown to come from one process.`;
    return options.allowUnstamped
      ? { line: `${line} Accepted because --allow-unstamped was given.`, exitCode: 0 }
      : { line: `${line} Pass --allow-unstamped if this is the run against the older deploy.`, exitCode: 1 };
  }
  if (result.missingHeaders || result.instances.length > 1) {
    return {
      line: `VERDICT ${result.instances.length} instance ids across the sequence${result.missingHeaders ? ' (plus responses with no header at all)' : ''} — more than one function or instance answered, so these latencies are not comparable. Check for a maxDuration/memory/runtime/preferredRegion export on a route, or for concurrent traffic scaling the deployment out.`,
      exitCode: 1,
    };
  }
  return {
    // The qualifier is the honest half: seven sequential requests to four of the
    // eight routes is what was observed. `/api/ask`, `/api/examples` and
    // `/api/recall` carry no header, `decomp` is stamped but not sampled, and a
    // second instance serving somebody else's traffic never appears in a
    // sequential run at all.
    line: `VERDICT one process answered every request (${result.instances[0]}) — the latencies above are a like-for-like series. Not observed: 4 of the 8 routes (/api/ask, /api/examples and /api/recall carry no header; /api/dict/decomp is stamped but unsampled), and any second instance serving concurrent traffic.`,
    exitCode: 0,
  };
}

/**
 * Did the warm-up finish during the wait? Read off the first post-wait sample.
 *
 * **"Settled" is `x-tangram-dict-warm`, not the parts list.** `warmDictionary()`
 * builds the six index parts *and* two caches that are keyed off the index object
 * rather than stored in it (`DICT_WARM_CACHES`), so `builtIndexParts()` — and
 * therefore the parts header — cannot see them however warm they are. A warm-up
 * that stops after the parts loop leaves a full parts list and a first reader
 * paste that still pays ~145 ms to build the DAG statistics, which is one of the
 * two pauses this phase exists to remove. So the parts list stays in the line as
 * the partial picture, and the verdict word comes from the flag.
 */
export function warmUpLine(result: ProbeResult): string {
  const afterWait = result.samples.find((s) => s.step.waitBeforeMs !== undefined);
  if (!afterWait || afterWait.parts === null) return 'warm-up: unknown (no parts header)';
  const built = afterWait.parts.length;
  const total = DICT_INDEX_PARTS.length;
  const missing = DICT_INDEX_PARTS.filter((part) => !afterWait.parts?.includes(part));
  const parts =
    built >= total
      ? `all ${total} index parts`
      : `${built}/${total} parts (missing ${missing.join(',')})`;
  const when = `${WARM_WAIT_MS} ms after the probe`;
  if (afterWait.warm === null) {
    // An older build: the parts are all it can say, and it must not round that up
    // to "settled".
    return `warm-up: unknown — ${parts} ${when}, and no ${DICT_WARM_HEADER} header, so the ${DICT_WARM_CACHES.join(' and ')} caches cannot be seen from here`;
  }
  if (afterWait.warm) return `warm-up: settled — ${DICT_WARM_HEADER}: yes, ${parts} ${when}`;
  return `warm-up: NOT settled — ${DICT_WARM_HEADER}: no ${when} (${parts}; at least one of the ${DICT_WARM_CACHES.join(', ')} caches is still cold, so a first search or first paste still pays for it)`;
}

/**
 * The probe's own flag, parsed here rather than in `parseArgs`.
 *
 * `parseArgs` is shared with `pnpm smoke` and exists so that `--base-url` and the
 * key are handled identically by both; a flag only one script understands does not
 * belong in it.
 */
const ALLOW_UNSTAMPED = '--allow-unstamped';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let baseURL: string;
  let secret: string | undefined;
  try {
    ({ baseURL, secret } = parseArgs(argv));
  } catch (error) {
    // `parseArgs` rejects a base URL it cannot use — including one carrying a
    // `?key=`, whose secret it lifts out rather than pasting into every request.
    console.error(`coldstart: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const allowUnstamped = argv.includes(ALLOW_UNSTAMPED);
  try {
    // Fail on an unusable key here, before it can be reported as "cannot reach".
    accessHeaders(secret);
  } catch (error) {
    console.error(`coldstart: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`coldstart: ${baseURL}${secret ? ' (with access cookie)' : ''}`);

  const gate = await gateCheck(baseURL, secret);
  if (!gate.ok) {
    console.error(`coldstart: refusing to run — ${gate.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`coldstart: gate — ${gate.state}`);
  console.log(
    `  ${'step'.padEnd(15)} ${'latency'.padStart(8)}  code  instance  index parts + warm`,
  );

  const result = await runProbe(baseURL, secret, (line) => console.log(line));
  console.log(`coldstart: ${warmUpLine(result)}`);
  if (result.instances.length > 0) {
    console.log(`coldstart: instances — ${result.instances.join(', ')}`);
  }
  const { line, exitCode } = verdict(result, { allowUnstamped });
  (exitCode === 0 ? console.log : console.error)(`coldstart: ${line}`);
  process.exitCode = exitCode;
}

// Only when run as a script, so a test can import the pieces above.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
