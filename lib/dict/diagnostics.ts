/**
 * The two response headers that make the shape of the deployment visible from a
 * phone: which process answered, and how much of the dictionary that process had
 * built when it did.
 *
 * They exist because the two questions this phase is about cannot be answered
 * from latency alone.
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
 *  2. **How warm?** `x-tangram-index-parts` is `builtIndexParts()` at the moment
 *     the response is stamped. Empty means nothing is built (a 503, or a 400 that
 *     never touched the data); `sorted,entries,hsk` is a process that has only
 *     answered the banner's probe; all six is a settled warm-up.
 *
 * `scripts/coldstart-probe.ts` reads exactly these two, and its verdict is the
 * instance id rather than a latency band.
 *
 * **Nothing here is sensitive and nothing here may become sensitive.** The id is
 * random and means nothing outside this process's lifetime — it is not the
 * deployment id, the region, the instance's address or anything an attacker can
 * work backwards from — and the parts list is a fixed vocabulary of six words
 * that is already public in this repo. Both are cheap: one string field read and
 * one array join over at most six entries, no allocation that scales with the
 * dictionary. Anything that fails either test does not belong in a header that
 * ships on every dictionary response.
 */
import { randomUUID } from 'node:crypto';

import { builtIndexParts } from './index';

/** Which process answered. See the module header. */
export const INSTANCE_HEADER = 'x-tangram-instance';

/** Which index parts that process had built when it answered. */
export const INDEX_PARTS_HEADER = 'x-tangram-index-parts';

/**
 * This process's id, minted once at module load.
 *
 * At module load rather than lazily on the first request: the value has to be
 * stable for the whole life of the process, and a lazy `??=` is a second way for
 * that to be true that can stop being true.
 */
export const INSTANCE_ID = randomUUID();

/**
 * Stamp the two headers onto a response and return it.
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
  return response;
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
