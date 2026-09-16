/**
 * The search contract — routing and ranking (PLAN.md §3.2).
 *
 * One box, no mode picker, so the router has to decide what the learner meant:
 *
 *   1. anything CJK          → hanzi: exact headwords, then prefixes, both scripts
 *   2. it parses as pinyin   → BOTH the pinyin and the gloss indexes, as labelled
 *                              sections whose order says which reading of the query
 *                              is more likely (`sun` is English, `dasuan` is pinyin)
 *   3. otherwise             → English glosses
 *
 * Results are grouped by headword (`trad|simp`), never by entry, so a polyphone
 * shows every reading it has instead of appearing three times: 了 is one result
 * carrying `le` and `liǎo`, which is also what makes "choose a reading" possible
 * on the way to a card.
 *
 * **What is left here after `data.md` D6, and why the file stays.** The routing
 * and ranking above used to be implemented here, over the seven in-memory
 * indexes `lib/dict/index.ts` built from `data/dict.json`. D6 deleted that
 * implementation: `lib/dict/sqlite-store.ts` does all of it over the artifact
 * on every platform, and the parts the two always shared — the grouping, the
 * five-key sort, the section allocation, the cursor — were already
 * `lib/dict/rank.ts`'s.
 *
 * So this module is now **the search layer's vocabulary**: `SearchResult` and
 * its parts, `SearchOptions`, and the re-exports that let a component import
 * `hasCjk` or `glossTier` from the module whose shapes it is already using.
 * `lib/dict/store.ts` — a frozen surface (`data.md` D1's first commit) — types
 * `DictStore.search` against `SearchResult` and `SearchOptions` from here, which
 * is the other reason the file cannot simply move: the freeze is on the shape,
 * and the shape lives at this path.
 */
import type { MatchSource } from './rank';
import type { DictEntry, EntryId, HskBand } from './types';

/**
 * The grouping, the five-key sort, the section allocation and the cursor are
 * `lib/dict/rank.ts`'s, shared with `lib/dict/sqlite-store.ts` (data.md D2).
 * The two implementations differ in which rows are candidates — that is what
 * D2's and D3's differential tests are for — and must not differ in what
 * happens to them afterwards.
 */
export { CJK_PATTERN, hasCjk, SEARCH_PAGE_SIZE } from './rank';
export type { MatchSource } from './rank';

/**
 * The gloss tiers, the lemmatiser and the stopword list are `lib/dict/rank.ts`'s
 * as of D3, so the store ranks FTS5's candidates with the same function this
 * module ranks its posting lists with. Re-exported because `search.test.ts` and
 * the ask pipeline import them from here.
 */
export { glossSenses, glossTier, lemma } from './rank';

/**
 * The two prefix caps come from the query modules rather than being declared
 * here as well. They are behaviour, not configuration — the JSON implementation
 * and the store must truncate at the same point or every differential test is
 * comparing two different questions — and one constant in two files is one
 * constant waiting to be edited in one of them.
 */
export { MAX_HANZI_PREFIX_IDS } from './query/hanzi';
export { MAX_PINYIN_PREFIX_IDS } from './query/pinyin';

/** Which router branch ran — useful in tests and in the API response. */
export type SearchRoute = 'hanzi' | 'pinyin+english' | 'english';

export interface SearchGroup {
  /** `trad|simp` — an entry id with the reading cut off. Stable, and the React key. */
  key: string;
  simp: string;
  trad: string;
  source: MatchSource;
  /** Ids that actually matched, best first. A subset of `entries`. */
  matchedIds: EntryId[];
  /** Every reading of this headword, matched ones first, then by frequency. */
  entries: DictEntry[];
  /** Lowest band among the readings, so the badge shows the easiest way in. */
  hskBand?: HskBand;
}

export interface SearchSection {
  source: MatchSource;
  /** Human label for the section header. */
  label: string;
  groups: SearchGroup[];
}

export interface SearchResult {
  query: string;
  route: SearchRoute;
  /** The capped page, in display order. `sections` is the same list, split up. */
  groups: SearchGroup[];
  sections: SearchSection[];
  /** Groups matched before the cap, so "showing 50 of 812" is honest. */
  total: number;
  /**
   * The CC-CEDICT snapshot these entries came from. It travels to the client
   * because `addCardFromEntry` stamps it onto the card snapshot, and a card that
   * cannot say which dictionary it was cut from cannot be re-checked later.
   */
  dictVersion: string;
  /** Results already shown before this page, summed over the sections. */
  offset: number;
  /** Pass back as `cursor` for the next page. Absent when this is the last one. */
  nextCursor?: string;
}

export interface SearchOptions {
  /** Groups per page. PLAN.md §3.2 caps a page at 50. */
  limit?: number;
  /** Opaque page marker from `nextCursor`. */
  cursor?: string;
  /**
   * Drop a superseded keystroke's work rather than rendering it
   * (docs/plans/data.md D2). Ignored by the JSON implementation, which is
   * synchronous; honoured by `lib/dict/sqlite-store.ts` and passed to the
   * runner, where on the Capacitor bridge it is the difference between a queued
   * round trip and a cancelled one.
   *
   * It rides in the options rather than as a third parameter because
   * `DictStore.search` is a frozen surface with two (data.md D1's first commit)
   * and `SearchOptions` is this layer's own.
   */
  signal?: AbortSignal;
}
