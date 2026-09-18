/**
 * The dictionary's domain API (docs/plans/data.md D1, D2).
 *
 * This is what the UI codes against: one interface over one prebuilt read-only
 * SQLite file, backed by `node:sqlite` in tests, `sqlite-wasm` on OPFS in the
 * browser (D4) and the Capacitor plugin on phones (D5a/D5b). Nothing above the
 * dictionary layer knows which.
 *
 * **Frozen by D1's first commit.** `core.md`'s gate table and `ios.md` §4 wait
 * on this file, not on the implementation, so a sibling plan may write
 * `const store: DictStore = fake` against it from the moment it lands. A change
 * here stops the build and goes into `HANDOFF.md` (CLAUDE.md, "Shared surfaces").
 *
 * The query-result shapes are imported rather than redeclared: `SearchResult`,
 * `SegmentResult` and their options are already the dictionary layer's contract
 * (`lib/dict/search.ts`, `lib/dict/segment.ts`) and PLAN.md §3.1 freezes `Entry`
 * inside `lib/types.ts` for the same reason — a shape copied into a second file
 * is a shape that can drift. These are `import type` and erase at compile, so
 * importing this module never pulls the fs-backed loader into a browser bundle.
 */
import type { SearchOptions, SearchResult } from './search';
import type { SegmentOptions, SegmentResult, SegmentScript } from './segment';
import type { DictEntry, EntryId, HskBand } from './types';

/**
 * Where the artifact is, as a state machine the UI can draw (data.md D4).
 *
 * `preparing` carries the fetch's progress so a determinate bar is possible;
 * `failed` distinguishes the four things that can go wrong because they need
 * different words on screen — a truncated download is "try again", a corrupt
 * file is "we will re-fetch it", and no storage is neither.
 */
export type DictStatus =
  | { state: 'absent' }
  | { state: 'preparing'; received?: number; total?: number }
  | { state: 'ready'; version: string }
  | { state: 'failed'; reason: 'download' | 'import' | 'storage' | 'corrupt'; message: string };

/**
 * Which rule matched a word the list importer asked about (`wave-zero.md` §8b).
 * `none` means the dictionary does not have it under any reading.
 */
export type ResolveVia = 'hanzi' | 'pinyin' | 'none';

export interface ResolvedWord {
  /** The word as asked, trimmed — so a picker can show what the learner wrote. */
  word: string;
  via: ResolveVia;
  /** Every candidate, most frequent first; empty when `via` is `none`. */
  entries: DictEntry[];
}

export interface ResolveResult {
  /** The artifact version the entries came from, for the same reason `search` carries it. */
  dictVersion: string;
  /** One per word asked, in the order asked. */
  results: ResolvedWord[];
}

export interface DictStore {
  readonly status: DictStatus;
  subscribe(listener: (status: DictStatus) => void): () => void;
  /** Idempotent; safe to call on every mount. */
  open(): Promise<void>;

  entries(ids: readonly EntryId[]): Promise<DictEntry[]>;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  segment(text: string, options?: SegmentOptions): Promise<SegmentResult>;
  /**
   * One HSK band, easiest first. `limit`/`offset` are new against today's
   * `hskBand(band)`: the call crosses a bridge now rather than a socket, and a
   * band of 5,638 entries is not a thing to serialise whole (data.md D6).
   */
  hskBand(band: HskBand, options?: { limit?: number; offset?: number }): Promise<DictEntry[]>;
  /** How many *readings* a simplified headword has — not how many rows. */
  readingCount(simp: string): Promise<number>;
  /** Every headword containing `ch`, in frequency order (the `char_words` table). */
  wordsContaining(
    ch: string,
    options?: { script?: SegmentScript; limit?: number },
  ): Promise<DictEntry[]>;
  /**
   * Bulk headword resolution for the list importer (`wave-zero.md` §8b).
   *
   * One word in, every entry it could mean out — deliberately **not** `search`.
   * `search` ranks across headwords and pages at 50, which is right for a person
   * typing and wrong for a 300-word paste where each line must resolve to its own
   * candidate set. The rule is the importer's, and it is the part of `abe6793`
   * worth keeping:
   *
   *   1. anything with a hanzi in it matches **exactly** against both scripts, so
   *      a simplified list and a traditional one resolve alike and a prefix never
   *      counts (`打` must not become 打算);
   *   2. otherwise, if it parses as pinyin, tone-exact first and toneless as the
   *      fallback (`nǐhǎo`, `ni3hao3` and `nihao` all find 你好);
   *   3. otherwise nothing — English is not a way to name a word for a list.
   *
   * Bulk rather than per-word because on the Capacitor bridge and the OPFS worker
   * a paste would otherwise be hundreds of round trips. Over `RESOLVE_MAX_WORDS`
   * or `RESOLVE_MAX_WORD_CHARS` (`lib/dict/resolve.ts`) is the caller's error,
   * not a truncation.
   */
  resolve(
    words: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<ResolveResult>;
}
