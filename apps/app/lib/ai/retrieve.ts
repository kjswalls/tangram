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
 * the ten `lib/ai/**` modules into it — has already run. It has not:
 * `docs/plans/README.md`'s verification register V6 records that deliverable as
 * not executable as written (it names ten modules to move and none of the 33
 * files with 74 import sites that break), and this session was scoped out of it.
 * So this lands at the pre-move spelling the register itself uses for D3's file,
 * `lib/ai/retrieve.ts`, and moves with its nine neighbours when someone
 * specifies that move. See HANDOFF.md, D3.
 */
import { ground, type GroundContext, type GroundedAskResponse, type RawAskResponse } from './ground';
import { hasCjk } from '../dict/rank';
import type { DictStore } from '../dict/store';
import type { Entry, EntryId, Token } from '../types';

/** §3.4 caps the retrieved set at 40 entries. */
export const RETRIEVED_CAP = 40;
/**
 * How much of the cap the dictionary search may take before the proposed
 * phrases have had their turn. A flat "search first, then proposals" order lets
 * a broad query eat all 40 rows, and then the words the answer is actually built
 * from are missing.
 */
export const SEARCH_HEAD = 16;

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

export async function groundWithStore(
  raw: RawAskResponse,
  store: DictStore,
  retrieved: readonly Entry[],
): Promise<GroundedAskResponse> {
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

    const grounded = ground(raw, context);
    if (wantSegments.size === 0 && wantEntries.size === 0 && wantReadings.size === 0) {
      return grounded;
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
  throw new Error('grounding did not converge; see lib/ai/retrieve.ts');
}
