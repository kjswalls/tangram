/**
 * The three response headers that make the shape of the deployment visible from
 * a phone: which process answered, how much of the dictionary that process had
 * built when it did, and whether the warm-up is actually finished.
 *
 * They exist because the questions this phase is about cannot be answered from
 * latency alone.
 *
 *  1. **Which process?** Vercel groups every route handler whose config matches
 *     into one function (docs/deploy.md §5), and the dictionary warm-up is a
 *     *per-process* fact — an index built by the instance that answered the
 *     banner's probe does nothing for a second instance that concurrency spun
 *     up. A fast response and a slow one are only comparable if they came from
 *     the same process, and `x-tangram-instance` is the only way to know that
 *     from outside. It is a `randomUUID()` generated once at module load, so it
 *     identifies the *process*, not the request: two responses carrying the same
 *     id ran in the same JS heap, and two ids means two heaps.
 *  2. **How much is built?** `x-tangram-index-parts` is `builtIndexParts()` at the
 *     moment the response is stamped. Empty means nothing is built (a 503, or a
 *     400 that never touched the data); `sorted,entries,hsk` is a process that has
 *     only answered the banner's probe; all six is every *index part* built.
 *  3. **Is the warm-up actually done?** `x-tangram-dict-warm` is `dictionaryWarm()`,
 *     and it is not a restatement of (2). `warmDictionary()` also builds two caches
 *     that live *outside* the `DICT_INDEX_PARTS` vocabulary — search's headword
 *     prefix indexes and the segmenter's DAG statistics (`DICT_WARM_CACHES`) — and
 *     they are keyed off the index object rather than stored in it, so
 *     `builtIndexParts()` cannot see them by construction. A process can report all
 *     six parts while a first reader paste still pays ~145 ms to build the DAG
 *     statistics; that state is exactly what a warm-up frozen half-way (an
 *     exhausted `waitUntil` budget, a regression that drops the cache passes) leaves
 *     behind, and reading (2) alone would call it settled. So (2) is the partial
 *     picture and (3) is the promise.
 *
 * `scripts/coldstart-probe.ts` reads exactly these three, its verdict is the
 * instance id rather than a latency band, and its "warm-up: settled" line requires
 * (3) rather than inferring it from (2).
 *
 * **Nothing here is sensitive and nothing here may become sensitive.** The id is
 * random and means nothing outside this process's lifetime — it is not the
 * deployment id, the region, the instance's address or anything an attacker can
 * work backwards from — the parts list is a fixed vocabulary of six words that is
 * already public in this repo, and the warm flag is one of two words. All three
 * are cheap: one string field read, one array join over at most six entries, and
 * two WeakMap lookups behind a length check, with no allocation that scales with
 * the dictionary. Anything that fails either test does not belong in a header that
 * ships on every dictionary response.
 */
import { randomUUID } from 'node:crypto';

import { builtIndexParts } from './index';
import { dictionaryWarm } from './warm';

/** Which process answered. See the module header. */
export const INSTANCE_HEADER = 'x-tangram-instance';

/** Which index parts that process had built when it answered. */
export const INDEX_PARTS_HEADER = 'x-tangram-index-parts';

/**
 * Whether everything `warmDictionary()` builds — the six index parts *and* the two
 * caches outside that vocabulary — was built in this process when it answered.
 * `yes` or `no`, nothing else.
 */
export const DICT_WARM_HEADER = 'x-tangram-dict-warm';

/**
 * This process's id, minted once at module load.
 *
 * At module load rather than lazily on the first request: the value has to be
 * stable for the whole life of the process, and a lazy `??=` is a second way for
 * that to be true that can stop being true.
 */
export const INSTANCE_ID = randomUUID();

/**
 * Stamp the three headers onto a response and return it.
 *
 * Mutates rather than rebuilding: a `Response` constructed in a handler has a
 * mutable header list, and copying one would mean copying its body too — which
 * for `HEAD`'s deliberately bodiless 200 would quietly change what it is.
 */
export function stampDictDiagnostics<T extends Response>(response: T): T {
  response.headers.set(INSTANCE_HEADER, INSTANCE_ID);
  // Read at *response* time, not at handler entry: for `HEAD /api/dict/hsk` the
  // whole point is what the handler built on its way to answering.
  // `builtIndexParts()` reads the module cache and never throws, so a 503 for
  // missing data is stamped with an empty list rather than turning into a 500.
  response.headers.set(INDEX_PARTS_HEADER, builtIndexParts().join(','));
  response.headers.set(DICT_WARM_HEADER, warmFlag());
  return response;
}

/**
 * `dictionaryWarm()`, made safe to call on the response path.
 *
 * Two guards, for two different hazards:
 *
 *  - **It must not load the dictionary.** `dictionaryWarm()` checks
 *    `builtIndexParts()` first and returns false before it ever reaches
 *    `getDictIndex()`, so on a process that has built nothing this is a length
 *    comparison — stamping a 400 that never touched the data still does not
 *    trigger the 33 MB parse.
 *  - **It must not turn a 503 into a 500.** On the `dict-data-missing` path the
 *    parts list is empty, so the early return already covers it; the `try` is
 *    belt and braces for any future shape of `dictionaryWarm()`, and an unknown
 *    answer is reported as `no` rather than as a crashed request. `no` is the
 *    conservative direction: it makes the probe say "NOT settled", never the
 *    reverse.
 */
function warmFlag(): 'yes' | 'no' {
  try {
    return dictionaryWarm() ? 'yes' : 'no';
  } catch {
    return 'no';
  }
}

/**
 * Wrap a dictionary route handler so every answer it gives carries the headers —
 * the 400s and the 503s included, which are the two where they are worth the
 * most, since those are the responses whose cause is invisible from a phone.
 *
 * A wrapper rather than a `stampDictDiagnostics(...)` at each `return` because
 * the five dictionary routes have twenty-odd return sites between them, and a
 * header that is on nineteen of them is worse than one that is on none: the
 * probe would read the gap as a different process.
 *
 * The return type follows the handler's own, so a synchronous handler stays
 * synchronous. `GET`, `HEAD` and the unit tests that call them directly all read
 * `.status` off the returned value, and making every dictionary route `async` to
 * fit a wrapper would be the tail wagging the dog.
 */
export function withDictDiagnostics<T extends Response | Promise<Response>>(
  handler: (request: Request) => T,
): (request: Request) => T {
  return (request: Request): T => {
    const result = handler(request);
    // The cast is the price of preserving sync-ness: TypeScript cannot see that
    // `Promise<Response>` in means `Promise<Response>` out and `Response` in
    // means `Response` out. Both branches produce exactly `T`.
    return (
      result instanceof Promise ? result.then(stampDictDiagnostics) : stampDictDiagnostics(result)
    ) as T;
  };
}
