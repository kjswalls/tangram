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
}
