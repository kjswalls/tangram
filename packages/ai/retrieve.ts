/**
 * Retrieval and grounding over a `DictStore` (docs/plans/data.md D3).
 *
 * `mergedSearch()` and `candidateEntries()` are the two halves of the ask
 * pipeline's retrieval step. They depend on `search`, `segment` and "an entry by
 * id" and on **nothing about the wire**, which is why they move here the moment
 * the store can answer all three rather than waiting for `backend.md` to decide
 * what `POST /api/ask` looks like. `app/api/ask/route.ts` keeps its
 * JSON-index-backed originals until `data.md` D6 deletes them, and
 * `tests/unit/ai/retrieve.test.ts` asserts the two agree entry for entry.
 *
 * **Path note.** `data.md` D3 writes this file as `packages/ai/retrieve.ts`,
 * because it assumes wave 0's deliverable 5 — creating `packages/ai/` and moving
 * the `lib/ai/**` modules into it — has already run. It had not when D3 landed,
 * so this file arrived at `apps/app/lib/ai/retrieve.ts` and travelled here with
 * its ten neighbours when deliverable 5 ran. It is now at D3's own spelling.
 * `hasCjk`, `DictStore` and `Entry` are still read out of `apps/app` through the
 * `@/*` mapping in this package's tsconfig; `backend.md` B1 is what breaks that
 * edge. See HANDOFF.md, D3 and wave 0 deliverable 5.
 */
import { ground, type GroundContext, type GroundedAskResponse, type RawAskResponse } from './ground.js';
import { RETRIEVED_CAP } from './schemas.js';
import { hasCjk } from '@/lib/dict/rank';
import type { DictStore } from '@/lib/dict/store';
import type { Entry, EntryId, Token } from '@/lib/types';

/**
 * §3.4 caps the retrieved set at 40 entries — **declared in `./schemas.ts` and
 * re-exported here**, not redeclared. That file is the frozen ask contract and
 * says so itself: "two constants of the same name in one package is a value the
 * edge validator and the client's own `mergeRetrieved()` can disagree about with
 * nothing failing to compile." This file held its own `= 40` while it lived in
 * `apps/app/lib/ai/`, where the two were in different packages and the warning
 * did not bite; wave 0 deliverable 5 is the move that put them side by side, so
 * it is the commit that has to honour it. `SEARCH_HEAD` below is the opposite
 * case — it shapes retrieval and never reaches the wire — so it stays here.
 */
export { RETRIEVED_CAP };
/**
 * How much of the cap the dictionary search may take before the proposed
 * phrases have had their turn. A flat "search first, then proposals" order lets
 * a broad query eat all 40 rows, and then the words the answer is actually built
 * from are missing.
 */
export const SEARCH_HEAD = 16;

/**
 * Does this query need the model's help to find words? A headword does not —
 * the dictionary already answered it. An English question or a whole sentence
 * does: nothing in the gloss index matches "how do I say I'm just browsing".
 *
 * **It lives here from `backend.md` B2.** It was four lines in
 * `app/api/ask/route.ts` and B2 names it among the symbols that move into this
 * module with `mergedSearch`, `candidateEntries`, `mergeRetrieved` and
 * `RETRIEVED_CAP`. It has to: after the contract flip the party that decides
 * whether to spend a round trip on `/api/ask/propose` is the client, and it
 * decides by segmenting against the dictionary it now holds.
 */
export async function needsProposals(store: DictStore, query: string): Promise<boolean> {
  if (!hasCjk(query)) return true;
  const segmented = await store.segment(query);
  return segmented.tokens.filter((token) => token.kind === 'word').length >= 3;
}

/** Entries for a query, in search order, deduped by id. */
async function searchEntries(store: DictStore, query: string, limit: number): Promise<Entry[]> {
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  const result = await store.search(query, { limit });
  for (const group of result.groups) {
    for (const entry of group.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/**
 * The merged dictionary search. An English question of several words matches no
 * gloss as a whole (the index is an AND over tokens), so its words are also
 * searched one at a time — otherwise the retrieval echo has nothing to echo and
 * §3.4's "no query ever renders an empty panel" fails on the first real sentence
 * somebody types.
 */
export async function mergedSearch(store: DictStore, query: string): Promise<Entry[]> {
  const found = await searchEntries(store, query, 20);
  // `hasCjk` comes from `lib/dict/rank.ts`, which is pure and is also where the
  // store's own router gets it: the ask pipeline must decide "is this Chinese"
  // exactly the way the search box does.
  if (found.length > 0 || hasCjk(query)) return found;

  const words = query
    .toLowerCase()
    .split(/[^a-z0-9'’-]+/i)
    .filter((word) => word.length >= 3);
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  for (const word of words.slice(0, 6)) {
    for (const entry of await searchEntries(store, word, 3)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/** Every entry behind every token of a proposed phrase, in phrase order. */
export async function candidateEntries(
  store: DictStore,
  candidates: readonly string[],
): Promise<Entry[]> {
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  for (const candidate of candidates.slice(0, 8)) {
    const text = candidate.trim().slice(0, 40);
    if (!text) continue;
    const segmented = await store.segment(text);
    const wanted: EntryId[] = [];
    for (const token of segmented.tokens) {
      if (token.kind !== 'word') continue;
      for (const id of token.entryIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        wanted.push(id);
      }
    }
    // One batch per phrase rather than one per token: `store.entries` keeps the
    // order asked for, which is the phrase order the route depends on.
    for (const entry of await store.entries(wanted)) out.push(entry);
  }
  return out;
}

/** Search head, then the proposals, then the rest of the search, up to the cap. */
export function mergeRetrieved(
  fromSearch: readonly Entry[],
  fromCandidates: readonly Entry[],
): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  const take = (entries: readonly Entry[], limit: number): void => {
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  };
  take(fromSearch, Math.min(SEARCH_HEAD, RETRIEVED_CAP));
  take(fromCandidates, RETRIEVED_CAP);
  take(fromSearch, RETRIEVED_CAP);
  return out;
}

// ---------------------------------------------------------------------------
// The synchronous/asynchronous seam
// ---------------------------------------------------------------------------

/**
 * `GroundContext.segment` is **synchronous** (`lib/ai/ground.ts`) and
 * `DictStore.segment` is not. Resolving that is this module's job, and the fix
 * is explicitly *not* to make `ground.ts` async: `tests/unit/ai/` encode its
 * rules — the citation rules, the uncited-run rules, the CJK stripping — and
 * churning that file to thread a promise through it would put the product's core
 * promise (§3.4, the dictionary is ground truth) through a refactor for a reason
 * that has nothing to do with it.
 *
 * So the dictionary work happens **before** `ground()` runs, and `ground()` is
 * handed plain maps. The catch D3 does not mention is that the strings to
 * segment are not knowable in advance: `ground()` segments each phrase it has
 * *rendered from the cited entries*, and rendering happens inside it. Rather
 * than re-implement that rendering here — two copies of the thing that decides
 * what a learner sees — `ground()` is run as a **fixed point**: each round
 * records what it asked for and could not be told, the store answers those, and
 * the round runs again. It converges in three rounds (segments, then the entry
 * ids the segmenter produced, then nothing), it is bounded, and `ground()` is
 * pure so running it three times costs microseconds against a model call.
 */
const MAX_GROUND_ROUNDS = 4;

/**
 * Run anything that wants a synchronous `GroundContext` over an asynchronous
 * `DictStore`.
 *
 * `groundWithStore` below is the ask pipeline's use of it. `data.md` D6 needed
 * a second one — `app/api/examples/route.ts` calls `groundExamples()`, which
 * takes the same context and applies the card-back rules on top — and copying
 * the fixed point into the route would have meant two loops that have to agree
 * about convergence. So the loop is the shared thing and the function it drives
 * is the parameter.
 *
 * `run` is called **several times with the same input** and must be pure, which
 * is exactly what `lib/ai/ground.ts` and `lib/ai/examples.ts` are. Anything it
 * asks the context for and is not told, it is told on the next round.
 */
export async function withStoreContext<T>(
  store: DictStore,
  retrieved: readonly Entry[],
  run: (context: GroundContext) => T,
): Promise<T> {
  const segments = new Map<string, Token[]>();
  const entries = new Map<EntryId, Entry>();
  const readings = new Map<string, number>();
  /**
   * Every id already put to the store, found or not.
   *
   * Without it a citation the dictionary does not have would be requested again
   * on every round and the loop would run to its bound and throw. `ground()`
   * happens to drop an id outside the retrieved set *before* asking, so today
   * nothing reaches that state — which is exactly why the guard is on the shape
   * of the loop rather than on that behaviour: the loop's termination must not
   * depend on a detail of the function it is driving.
   */
  const asked = new Set<EntryId>();
  for (const entry of retrieved) entries.set(entry.id, entry);

  for (let round = 0; round < MAX_GROUND_ROUNDS; round += 1) {
    const wantSegments = new Set<string>();
    const wantEntries = new Set<EntryId>();
    const wantReadings = new Set<string>();

    const context: GroundContext = {
      retrieved,
      segment: (text) => {
        const known = segments.get(text);
        if (known) return known;
        wantSegments.add(text);
        return [];
      },
      entry: (id) => {
        const known = entries.get(id);
        if (!known && !asked.has(id)) wantEntries.add(id);
        return known;
      },
      readings: (simp) => {
        const known = readings.get(simp);
        if (known === undefined) wantReadings.add(simp);
        return known ?? 0;
      },
    };

    const result = run(context);
    if (wantSegments.size === 0 && wantEntries.size === 0 && wantReadings.size === 0) {
      return result;
    }

    await Promise.all([
      ...[...wantSegments].map(async (text) => {
        segments.set(text, (await store.segment(text)).tokens);
      }),
      (async () => {
        for (const id of wantEntries) asked.add(id);
        for (const entry of await store.entries([...wantEntries])) entries.set(entry.id, entry);
      })(),
      ...[...wantReadings].map(async (simp) => {
        readings.set(simp, await store.readingCount(simp));
      }),
    ]);
  }

  // Four rounds without closing means something asks for a new string every
  // time, which `ground()` cannot do — it is a bug here, not a slow convergence.
  throw new Error('grounding did not converge; see packages/ai/retrieve.ts');
}

export async function groundWithStore(
  raw: RawAskResponse,
  store: DictStore,
  retrieved: readonly Entry[],
): Promise<GroundedAskResponse> {
  return withStoreContext(store, retrieved, (context) => ground(raw, context));
}
