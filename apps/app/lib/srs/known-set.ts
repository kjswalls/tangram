/**
 * The learner's known set — the browser-side half of i+1 example sentences.
 *
 * **Why it is here and not in `packages/ai`.** It was, until `backend.md` B1.
 * These six functions are the only thing in the package that read the learner's
 * database: `knownSet` needs `isPhraseSnapshot` and `CardRow` from
 * `lib/db/schema`, `wordState` from `lib/srs/states` and `KNOWN_SAMPLE_LIMIT`
 * from `lib/srs/profile`, and `getKnownSet` takes a `Repository`. B1 moves the
 * three model routes into `apps/server`, and a shared package that drags
 * `lib/db/schema.ts` — the file `backend.md` B4 rewrites — into the server's
 * bundle is the opposite of what a shared package is for.
 *
 * B1 offers two ways out and says the choice must be made in the phase and
 * written into `HANDOFF.md`: inject the schema helpers, or extract a package.
 * **Neither was needed, because `wave-zero.md` §5's own rule already decides
 * it**: `packages/ai/` holds "anything the app and the server both need", and
 * the server needs none of this. It resolves the learner's vocabulary out of
 * Dexie, which exists only in the browser. So the code moved rather than
 * changing shape — every function below is byte-identical to the one that was
 * in `packages/ai/examples.ts`, which is what keeps B1's "the review has one
 * variable" promise.
 *
 * **And it lands in `lib/srs/`, not in `lib/ai/`.** `wave-zero.md` §5 says
 * `apps/app/lib/ai/` holds only `ask-client.ts`, and
 * `tests/unit/ai/contract.test.ts` enforces it; that is a ruling, not a
 * preference, so this went to the directory that already owns the question it
 * answers. `wordState` and `KNOWN_SAMPLE_LIMIT` are both `lib/srs/`'s, and
 * `profile.ts` next door builds the looser `LearnerProfile.knownSample` off the
 * same rows — the difference between the two sets is stated below and is the
 * reason they are neighbours rather than one function.
 *
 * What stayed behind in `packages/ai/examples.ts` is the half both sides run:
 * the grounding, `keepSentence`, `groundExamples`, `citedEntryIds` and the
 * caps. This module imports two of them and adds nothing to them.
 */
import { keepSentence, MAX_BAND_EXCEPTIONS, type ExampleSentence } from '@tangram/ai/examples';
import { SUPPORT_CAP } from '@tangram/ai/schemas';
import type { Repository } from '@/lib/db/repository';
import type { DictStore } from '@/lib/dict/store';
import { isPhraseSnapshot, type CardRow, type KnownBand, type SettingsRow } from '@/lib/db/schema';
import { KNOWN_SAMPLE_LIMIT } from '@/lib/srs/profile';
import { wordState } from '@/lib/srs/states';
import { HSK_BANDS, parseEntryId, type Entry, type EntryId, type HskBand } from '@/lib/types';

export interface KnownSetInput {
  settings: Pick<SettingsRow, 'knownBand'>;
  cards: readonly CardRow[];
  /** `known_words`, as `repo.knownEntryIds()` returns it. */
  known: readonly EntryId[];
}

/** What a known word sorts on: frequency first, band as the tiebreak. */
interface HeadwordRank {
  band?: HskBand;
  freqRank?: number;
}

/**
 * The learner's known vocabulary, in the three shapes this feature needs.
 *
 * Membership is `wordState` (`lib/srs/states.ts`) — the same call the reader
 * colours a token with and Lists labels a row with — so "known" means here what
 * it means everywhere else, and the three thresholds behind it are stated in
 * one place. Note the difference from `LearnerProfile.knownSample`, which is
 * deliberately looser (it counts *learning* words too, because the profile's
 * job is to describe the learner to a model, not to promise anything): a
 * sentence containing a word the learner is still learning is not a sentence
 * made of words they know, so this set is the strict one.
 *
 * `wordState` has three branches and each one needs a different shape to cross
 * the wire, which is why this is not just a list of words:
 *
 *  - **`ids`** is the exact entries the learner has met — a `known_words` row,
 *    or a card mature enough to count. Ids, not headwords: 看 is two entries
 *    (kàn "to see", kān "to look after") and a learner who knows one of them
 *    has never met the other. The filter's whitelist is built from *these*, so
 *    a sentence that cites the other reading is dropped.
 *  - **`headwords`** is the same set as characters, for the prompt only. A
 *    model reads words, not ids, and offering it a headword costs nothing —
 *    the filter is what enforces.
 *  - **`knownBand` + `excludeIds`** is the /settings "Assume known through HSK
 *    N" control, which names words the learner has no card for and no
 *    `known_words` row for. It cannot be expanded here — that needs the
 *    dictionary, which is the server's — so it travels as the band plus the
 *    exceptions to it, `wordState`'s rule that a card outranks the band.
 *
 * `headwords` and `ids` are capped at `KNOWN_SAMPLE_LIMIT` and truncated
 * **client-side**, exactly as the profile is (§3.3): the server is never sent
 * more of a learner's vocabulary than it needs to answer.
 */
export interface KnownSet {
  /** Simplified headwords, most frequent first. What the prompt is shown. */
  headwords: string[];
  /** The exact entries. What the filter's whitelist is built from. */
  ids: EntryId[];
  /** `settings.knownBand`: bands at or below it are assumed known. */
  knownBand: KnownBand;
  /** Entries inside those bands the learner is *not* done with, by id. */
  excludeIds: EntryId[];
}

export function knownSet(input: KnownSetInput, limit: number = KNOWN_SAMPLE_LIMIT): KnownSet {
  const declared = new Set(input.known);
  const knownBand = input.settings.knownBand;
  const found = new Map<string, HeadwordRank>();
  const ids = new Map<EntryId, HeadwordRank>();
  const excludeIds: EntryId[] = [];

  for (const card of input.cards) {
    if (card.kind !== 'word' || isPhraseSnapshot(card.snapshot)) continue;
    const band = card.snapshot.hskBand;
    const state = wordState({
      card: card.fsrs,
      known: card.entryId ? declared.has(card.entryId) : false,
      hskBand: band,
      knownBand,
    });
    if (state !== 'known') {
      // The band assumption is a guess about words the learner has never
      // touched, and a card outranks it (`wordState`). Without this list the
      // server's band expansion would quietly promote the word the learner is
      // being taught right now back into "words you know".
      if (card.entryId && band !== undefined && band <= knownBand) excludeIds.push(card.entryId);
      continue;
    }
    const rank: HeadwordRank = { band, freqRank: card.snapshot.freqRank };
    if (card.entryId && !ids.has(card.entryId)) ids.set(card.entryId, rank);
    if (!found.has(card.snapshot.simp)) found.set(card.snapshot.simp, rank);
  }

  // A word declared known that never got a card: the headword is recoverable
  // from the entry id, so it counts without a dictionary round-trip.
  for (const entryId of declared) {
    if (!ids.has(entryId)) ids.set(entryId, {});
    const parsed = parseEntryId(entryId);
    if (parsed && !found.has(parsed.simp)) found.set(parsed.simp, {});
  }

  const byRank = (left: HeadwordRank, right: HeadwordRank): number =>
    (left.freqRank ?? Number.MAX_SAFE_INTEGER) - (right.freqRank ?? Number.MAX_SAFE_INTEGER) ||
    (left.band ?? 99) - (right.band ?? 99);

  return {
    headwords: [...found.entries()]
      .sort(
        ([leftWord, left], [rightWord, right]) =>
          byRank(left, right) ||
          // The headword itself is the last tiebreak: most of a demo learner's
          // known words come from `known_words` rows that carry neither rank,
          // and "whatever order the database handed them back" is not a cache
          // key's idea of stable.
          (leftWord < rightWord ? -1 : 1),
      )
      .slice(0, limit)
      .map(([simp]) => simp),
    ids: [...ids.entries()]
      .sort(([leftId, left], [rightId, right]) => byRank(left, right) || (leftId < rightId ? -1 : 1))
      .slice(0, limit)
      .map(([id]) => id),
    knownBand,
    excludeIds: excludeIds.slice(0, MAX_BAND_EXCEPTIONS),
  };
}

/** Just the headwords, for callers that only need the prompt's half. */
export function knownHeadwords(
  input: KnownSetInput,
  limit: number = KNOWN_SAMPLE_LIMIT,
): string[] {
  return knownSet(input, limit).headwords;
}

/** `knownSet` over the repository. The card back's one database read. */
export async function getKnownSet(
  repo: Pick<Repository, 'getSettings' | 'allCards' | 'knownEntryIds'>,
  limit?: number,
): Promise<KnownSet> {
  const [settings, cards, known] = await Promise.all([
    repo.getSettings(),
    repo.allCards(),
    repo.knownEntryIds(),
  ]);
  return knownSet({ settings, cards, known }, limit);
}

/**
 * Does the learner know this **entry**? The client's half of the same question
 * `/api/examples` answers with the dictionary in hand.
 *
 * The band branch is why this takes an `Entry` rather than an id: a band is a
 * property of the dictionary row, and the row only reaches the browser once
 * the dictionary store has resolved it. It reads `wordState` in the one order
 * that matters — a declared id, then the band, minus the cards that outrank it.
 */
export function knownEntryFilter(
  set: KnownSet,
): (entry: Pick<Entry, 'id' | 'hskBand'>) => boolean {
  const ids = new Set(set.ids);
  const excluded = new Set(set.excludeIds);
  return (entry) =>
    ids.has(entry.id) ||
    (!excluded.has(entry.id) && entry.hskBand !== undefined && entry.hskBand <= set.knownBand);
}

// ---------------------------------------------------------------------------
// The cache's re-check
// ---------------------------------------------------------------------------

/** Which of these resolved entries the learner knows, as `keepSentence` wants them. */
export function allowedEntryIds(entries: readonly Entry[], set: KnownSet): Set<EntryId> {
  const known = knownEntryFilter(set);
  return new Set(entries.filter(known).map((entry) => entry.id));
}

/**
 * The filter, run again on a **cached** row before it is drawn.
 *
 * A cached sentence is a statement about a known set, and the cache key does
 * not hold one (`examplesCachePayload`). Two ordinary things then make a warm
 * row a lie:
 *
 *  - **The known set shrinks.** Every explicit Add un-marks the word it was
 *    built from (`repo.unmarkKnown`, `lib/lists/looked-up.ts`) and the new card
 *    outranks the band assumption, so the most common action in the app can
 *    turn a word in yesterday's sentence into a word the learner is currently
 *    being taught.
 *  - **The dictionary is rebuilt.** An entry id is content-derived, so a
 *    CC-CEDICT snapshot that respells a reading retires the id — and the token
 *    that cited it resolves to nothing. `renderPhrase` reports that as
 *    `missing`, and a sentence with a hole in it is the one thing the module
 *    header says must never be shown.
 *
 * So: every token must still resolve, and every cited entry must still be the
 * target or known. What does not survive is dropped, and the caller asks again
 * rather than drawing a sentence it can no longer stand behind.
 */
export function filterCachedSentences(
  sentences: readonly ExampleSentence[],
  options: { targetId: EntryId; entries: readonly Entry[]; set: KnownSet },
): ExampleSentence[] {
  const resolved = new Set(options.entries.map((entry) => entry.id));
  const allowed = allowedEntryIds(options.entries, options.set);
  return sentences.filter(
    (sentence) =>
      sentence.tokens.every(
        (token) => token.entryId !== undefined && resolved.has(token.entryId),
      ) && keepSentence(sentence, { targetId: options.targetId, allowed }),
  );
}

// ---------------------------------------------------------------------------
// The support pool — `backend.md` B2's contract flip
// ---------------------------------------------------------------------------

/**
 * The dictionary rows the learner knows, most frequent first — the **support**
 * pool, which is both what the examples prompt may build from and (after the
 * cap) what a sentence may cite.
 *
 * **It ran on the server until `backend.md` B2.** It could, because the server
 * held the dictionary; after the flip it is the client that resolves ids and
 * bands into rows, so the pool is assembled here and sent. Nothing about the
 * rules changed and this is deliberately the same function, moved: it is
 * assembled from ids and bands, never from characters, and that is the whole
 * point. A headword is not a word: 看 is `看|看[kan4]` "to see" (HSK 1) *and*
 * `看|看[kan1]` "to look after" (HSK 6); 会 is huì and kuài; 还 is hái, huán and
 * the surname Huán. Expanding a known headword into every entry that shares its
 * characters puts readings the learner has never met into the whitelist, and
 * the card back then shows them under the heading "Sentences from words you
 * know". The tone is the whole difference in meaning, and a learner cannot
 * check it — that is why they are here.
 *
 * The three sources:
 *
 *  1. **`ids`** — exact, and the only one that needs no judgement.
 *  2. **`knownBand`** — the "Assume known through HSK N" control. `hskBand` is a
 *     property of an *entry*, so the expansion is per reading and stays exact:
 *     看[kan4] is band 1, 看[kan1] is band 6. `excludeIds` carries `wordState`'s
 *     rule that a card outranks the band.
 *  3. **`headwords`** — the fallback for a caller with no ids, and deliberately
 *     lossy: a headword with more than one entry is **skipped**, because "the
 *     learner knows 看" does not say which 看. Variants, proper nouns and
 *     surnames are dropped too; none of them is a word somebody learned.
 */
export interface SupportPool {
  /** Exact entry ids: a `known_words` row, or a card mature enough to count. */
  ids?: readonly EntryId[];
  /**
   * `settings.knownBand` — every entry at or below it is assumed known.
   *
   * `KnownBand`, not `HskBand`: **0 is a real value** and means "assume
   * nothing", which is the default. The band loop below adds nothing for it
   * because no `HskBand` is ≤ 0, which is the same answer the route's old
   * `parseBody` reached by dropping an out-of-range band to `undefined`.
   */
  knownBand?: KnownBand;
  /** Entries inside those bands the learner is still learning. */
  excludeIds?: readonly EntryId[];
  /** Simplified headwords, for a caller that has no ids. See above. */
  headwords?: readonly string[];
}

export async function supportEntries(
  store: DictStore,
  pool: SupportPool,
  exclude: EntryId,
): Promise<Entry[]> {
  const excluded = new Set<string>(pool.excludeIds ?? []);
  const seen = new Set<EntryId>([exclude]);
  const out: Entry[] = [];

  const add = (entry: Entry | undefined): void => {
    if (!entry || seen.has(entry.id) || excluded.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const entry of await store.entries(pool.ids ?? [])) add(entry);

  if (pool.knownBand !== undefined) {
    /**
     * **Bounded, and the bound is exact rather than a guess.**
     *
     * This ran on the server before `backend.md` B2, in process against
     * `node:sqlite` on a warm machine, and read whole bands: with
     * `knownBand: 7` that is **11,028 rows and 3.16 MB of JSON**, to choose the
     * forty this function returns. After the flip it runs in a WebView, over
     * OPFS, on the first flip of every review card — and `lib/dict/query/hsk.ts`
     * grew `limit`/`offset` warning about exactly this ("not a thing to
     * serialise whole on the way to a list that shows fifty"). An adversarial
     * reviewer caught that the move had not taken the warning with it.
     *
     * `hsk_sort` **is** frequency order — `hskBandQuery` orders by it and
     * `hsk.ts`'s header says it folds the null-`freqRank` sentinel in so that
     * SQLite's NULLS-first does not put unranked entries at the head — so the
     * first `perBand` rows of a band are its most frequent.
     *
     * Why `+ excluded.size + 1` and not a round number: an entry outside a
     * band's top `perBand` has at least `perBand` entries in its own band that
     * beat it. At most `excluded.size` of those are excluded and at most one is
     * the target, so at least `SUPPORT_CAP` of them survive and beat it — which
     * means it cannot reach the cut. The bound is therefore not an
     * approximation, and `tests/unit/srs/support-pool.test.ts` asserts the
     * bounded read returns exactly what the unbounded one did.
     */
    const perBand = SUPPORT_CAP + excluded.size + 1;
    for (const band of HSK_BANDS) {
      if (band > pool.knownBand) continue;
      for (const entry of await store.hskBand(band, { limit: perBand })) add(entry);
    }
  }

  for (const word of pool.headwords ?? []) {
    const bucket = await readingsOf(store, word);
    if (bucket.length !== 1) continue;
    const [entry] = bucket;
    if (!entry || entry.properNoun || entry.isVariant || entry.surname) continue;
    add(entry);
  }

  return out.sort(
    (a, b) =>
      (a.freqRank ?? Number.MAX_SAFE_INTEGER) - (b.freqRank ?? Number.MAX_SAFE_INTEGER) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * The support pool the wire carries: frequency-ordered and cut to `SUPPORT_CAP`.
 *
 * The cut is here rather than at the call site because the cap is the contract's
 * (`packages/ai/schemas.ts`) and the server rejects anything over it — a client
 * that assembled the pool and forgot to cut it would 400 on the learner's most
 * ordinary review. The pool is ordered *before* it is cut, so what survives is
 * the vocabulary a natural sentence reaches for first.
 */
export async function offeredSupport(
  store: DictStore,
  pool: SupportPool,
  exclude: EntryId,
): Promise<Entry[]> {
  return (await supportEntries(store, pool, exclude)).slice(0, SUPPORT_CAP);
}

/**
 * Every entry whose **simplified** headword is exactly `word` — what
 * `lib/dict/index.ts`'s `bySimp.get(word)` answered before `data.md` D6 deleted
 * it.
 *
 * A `DictStore` has no `bySimp`, deliberately: the frozen interface asks
 * questions a learner asks, and "every row under this simplified form" is an
 * index, not a question. The exact-match section of a hanzi search is the same
 * set, so the rows are taken from there and filtered to the simplified side.
 *
 * It spans **groups**, not one group: a group is one `trad|simp` pair, while
 * CC-CEDICT keeps a row per traditional variant, so 后 is 后|后 *and* 後|后 and
 * the caller's rule ("skip a headword with more than one entry") reads the count
 * across both. The limit is 200 because the exact matches lead the page and no
 * headword has anything near that many readings; prefix matches are dropped by
 * the `simp === word` filter.
 *
 * **One thing `bySimp` answered that this cannot**, measured against the built
 * artifact rather than assumed (`wave-zero.md` §10f corrects the figure D6
 * recorded): `DictStore.search` routes on whether the query contains CJK, so the
 * **74** CC-CEDICT headwords that contain none — `ACG`, `3Q`, `110`, the Suzhou
 * numerals — go down the English/pinyin path and never match themselves exactly.
 * A mixed headword (`X光`, `卡拉OK`) is fine. Reaching them would need a
 * `bySimp`-shaped question on the frozen `DictStore` interface, and §10f rules
 * that not worth unfreezing the surface for on its own.
 */
async function readingsOf(store: DictStore, word: string): Promise<Entry[]> {
  const result = await store.search(word, { limit: 200 });
  return result.groups.filter((group) => group.simp === word).flatMap((group) => group.entries);
}
