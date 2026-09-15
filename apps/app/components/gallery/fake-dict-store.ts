/**
 * A `DictStore` whose status a human (or a spec) can drive (docs/plans/core.md
 * C4a).
 *
 * C1 put the dictionary's four states in the gallery as **stubs** — a
 * `DictStatusView` handed a literal. C4a's criterion is that they are real
 * screens driven by `store.status` and `store.subscribe()`, which is a
 * different claim: that the gate re-renders when the store moves, that a
 * determinate bar's value *moves*, and that a retry reaches the store. A
 * literal cannot fail any of those.
 *
 * It lives under `components/gallery/` on purpose. The gallery is excluded from
 * a production build by `src/routes.tsx`'s build-time guard, so this goes with
 * it and there is no fake `DictStore` in the shipped bundle.
 *
 * `data.md` D2/D3's in-Node `SqliteDictStore` is the other way to drive these,
 * and is what `core.md` §4 names first — but it needs a `SqlRunner` in the
 * browser, which is D4 and has not landed. This is the hand-written fake §4
 * allows in the meantime, against the same frozen interface.
 */
import type { DecompCharacter, DecompStore } from '@/lib/dict/decomp-store';
import type { SearchResult } from '@/lib/dict/search';
import type { SegmentResult } from '@/lib/dict/segment';
import type { DictStatus, DictStore } from '@/lib/dict/store';
import type { DictEntry } from '@/lib/dict/types';

export class FakeDictStore implements DictStore {
  #status: DictStatus;
  #listeners = new Set<(status: DictStatus) => void>();
  /** Every `open()` this store has been asked for — a retry is observable. */
  opens = 0;

  constructor(initial: DictStatus = { state: 'absent' }) {
    this.#status = initial;
  }

  get status(): DictStatus {
    return this.#status;
  }

  subscribe(listener: (status: DictStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Drive it. The gallery's buttons and the e2e both go through here. */
  set(status: DictStatus): void {
    this.#status = status;
    for (const listener of [...this.#listeners]) listener(status);
  }

  async open(): Promise<void> {
    this.opens += 1;
    // A retry starts the download again, which is what every failure screen
    // offers — the artifact is content-addressed, so it is the same file.
    if (this.#status.state !== 'ready') this.set({ state: 'preparing', received: 0, total: TOTAL });
  }

  async entries(): Promise<DictEntry[]> {
    return [];
  }
  async search(): Promise<SearchResult> {
    return { query: '', route: 'hanzi', groups: [], sections: [], total: 0, offset: 0, dictVersion: 'fake' };
  }
  async segment(text: string): Promise<SegmentResult> {
    return { text, script: 'simp', tokens: [] };
  }
  async hskBand(): Promise<DictEntry[]> {
    return [];
  }
  async readingCount(): Promise<number> {
    return 0;
  }
  async wordsContaining(): Promise<DictEntry[]> {
    return [];
  }
}

/** `data.md` D1 measured the artifact at 13.9 MB brotli. */
export const TOTAL = 13_900_000;

export class FakeDecompStore implements DecompStore {
  async decompose(chars: string): Promise<DecompCharacter[]> {
    return [...chars].map((char) => ({ char, entry: null }));
  }
}
