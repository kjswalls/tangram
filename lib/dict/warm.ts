/**
 * Warming the dictionary — building, once per process and off the critical path,
 * everything a session is going to need anyway.
 *
 * The indexes in `lib/dict/index.ts` are lazy so that a request pays only for the
 * parts it reads. That is the right default and it is not what this file changes.
 * What it changes is *when* the bill arrives. Measured in one warm process, a
 * session pays:
 *
 *   - app open, the banner's `HEAD /api/dict/hsk` → `sorted`, `entries`, `hsk`
 *     (~0.65 s, nobody waiting on it);
 *   - **first lookup** → `hanzi`, `pinyin`, `gloss` and the search headword cache
 *     (~1.0–1.4 s, and a learner is watching the box);
 *   - **first reader paste** → the segmenter's DAG statistics (~0.1–0.3 s, likewise).
 *
 * `warmDictionary()` moves the second and third bills onto the first moment, which
 * is already unattended. Two properties make that safe rather than merely earlier:
 *
 *  1. **It yields inside each part, not between them.** Node is single-threaded, so
 *     every millisecond spent building is a millisecond in which this instance
 *     serves nobody — not another route, not a static file. Yielding at part
 *     boundaries alone was measured at six yields across 1209 ms with a worst stall
 *     of 400 ms, and any request landing in that window paid it: `GET /lookup`
 *     went from 21 ms to 1.32 s. So the parts are built through the slice-wise
 *     generators in `lib/dict/incremental.ts` — a few thousand entries per step —
 *     and this file's only job is to hand the loop back between the steps.
 *  2. **It is memoised on the in-flight promise.** Two overlapping calls — the
 *     banner's probe racing a real request that also warms — must not build the
 *     47,000-key gloss index twice.
 *
 * The one thing it cannot slice is the `dict.json` parse (~440 ms) that
 * `getDictIndex()` does on first use: that is atomic inside `JSON.parse`. It is
 * paid *before* this promise exists — in the real path by the HEAD handler, inside
 * its own response, which is where it already was.
 *
 * Everything it touches is already memoised per process by `dictCache()`, so a
 * second call once things are warm is a WeakMap lookup and a few getter reads.
 */
import {
  buildPartInSlices,
  builtIndexParts,
  DICT_INDEX_PARTS,
  getDictIndex,
  type DictIndex,
  type DictIndexPart,
} from './index';
import { headwordsWarm, warmHeadwordsInSlices } from './search';
import { segmentStatsWarm, warmSegmentStatsInSlices } from './segment';

/**
 * The caches that are *not* index parts: `search.ts`'s headword prefix indexes and
 * `segment.ts`'s DAG statistics. They are keyed off the index object rather than
 * stored in it, so `builtIndexParts()` cannot see them and a warm-up that only
 * walked `DICT_INDEX_PARTS` would leave both of the felt pauses in place.
 */
export const DICT_WARM_CACHES = ['headwords', 'segment-stats'] as const;
export type DictWarmCache = (typeof DICT_WARM_CACHES)[number];

export interface WarmResult {
  /** Index parts this process had already built when the warm-up started. */
  alreadyBuilt: DictIndexPart[];
  /** Index parts this warm-up built, in `DICT_INDEX_PARTS` order. */
  built: DictIndexPart[];
  /** Non-part caches this warm-up built. */
  caches: DictWarmCache[];
  /** Wall clock spent, yields included. Diagnostic; nothing branches on it. */
  ms: number;
  /**
   * How many times it handed the event loop back. Diagnostic, and the one number
   * that says "in slices" without a stopwatch: a part-at-a-time warm-up scores 8.
   */
  steps: number;
}

/**
 * What a route logs when `after()` refuses the warm-up. Exported so the test can
 * assert the warning instead of asserting silence, and so it lives outside the
 * route module, which may export only handlers and route config.
 */
export const WARM_UP_NOT_SCHEDULED = 'dict warm-up not scheduled';

/**
 * Hand the event loop back.
 *
 * `setImmediate`, not `await null`: a microtask yield runs before pending I/O, so
 * it would let the warm-up finish end to end without ever serving the request that
 * arrived in the middle. A macrotask is the one that puts the socket first.
 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Run a slice-wise builder, handing the loop back between every step. */
async function drive(steps: Generator<void>): Promise<number> {
  let count = 0;
  let step = steps.next();
  while (!step.done) {
    await yieldToLoop();
    count += 1;
    step = steps.next();
  }
  return count;
}

/**
 * The warm-up in flight, keyed on the index object it is warming. A WeakMap and
 * not a module variable so that `resetDictCache()` — which drops the index — drops
 * this with it, exactly as the two caches it warms already do.
 */
const IN_FLIGHT = new WeakMap<DictIndex, Promise<WarmResult>>();

async function warmAll(index: DictIndex): Promise<WarmResult> {
  const startedAt = performance.now();
  const alreadyBuilt = builtIndexParts();
  let steps = 0;

  for (const part of DICT_INDEX_PARTS) {
    // Already-built parts drive to completion in zero steps, so the parts the
    // probe paid for cost nothing here.
    steps += await drive(buildPartInSlices(part));
  }

  // The two caches outside the parts vocabulary. Asked *before* driving, so
  // `caches` reports what this warm-up built rather than what is now warm.
  const caches: DictWarmCache[] = [];
  const buildsHeadwords = !headwordsWarm(index);
  steps += await drive(warmHeadwordsInSlices(index));
  if (buildsHeadwords) caches.push('headwords');
  const buildsSegmentStats = !segmentStatsWarm(index);
  steps += await drive(warmSegmentStatsInSlices(index));
  if (buildsSegmentStats) caches.push('segment-stats');

  const built = builtIndexParts().filter((part) => !alreadyBuilt.includes(part));
  return { alreadyBuilt, built, caches, ms: performance.now() - startedAt, steps };
}

/**
 * Build every dictionary index part and both out-of-band caches, in slices,
 * yielding between them. Idempotent, cheap once warm, and safe to call
 * concurrently with itself.
 *
 * Throws `DictDataMissingError` when `data/` has not been built — synchronously,
 * from the same `getDictIndex()` every route already calls, so a caller inside a
 * route's `try` gets the usual 503 rather than a rejected promise it forgot about.
 */
export function warmDictionary(): Promise<WarmResult> {
  const index = getDictIndex();
  const existing = IN_FLIGHT.get(index);
  if (existing) return existing;

  const run = warmAll(index);
  IN_FLIGHT.set(index, run);
  // A settled promise is kept: a later call then costs one WeakMap lookup and
  // reports, truthfully, what this process built. A *rejected* one is forgotten,
  // so a warm-up that died half-way can be retried instead of being remembered as
  // done. `.catch` here also means the memo never counts as an unhandled
  // rejection; the promise handed to the caller is a separate handle.
  void run.catch(() => {
    IN_FLIGHT.delete(index);
  });
  return run;
}

/** Whether everything `warmDictionary()` builds is built in this process. */
export function dictionaryWarm(): boolean {
  const parts = builtIndexParts();
  if (parts.length !== DICT_INDEX_PARTS.length) return false;
  const index = getDictIndex();
  return headwordsWarm(index) && segmentStatsWarm(index);
}
