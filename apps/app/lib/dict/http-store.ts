/**
 * A `DictStore` over the HTTP routes (docs/plans/core.md C4, C4a).
 *
 * **This is a bridge, and it is meant to be deleted.** `data.md` D2/D3 build the
 * real `SqliteDictStore`, D4 gives the browser a `SqlRunner` over `sqlite-wasm`
 * on OPFS, and D6 then deletes `app/api/dict/**` — at which point this file goes
 * with them. Until D4 lands there is **no `DictStore` a browser can construct**:
 * `lib/dict/runners/` contains a Node runner and nothing else. So C4's sheets
 * and C4a's cutover would have had nothing to inject, and every consumer would
 * have stayed on `lib/dict/client.ts` for a phase whose whole point is that they
 * do not.
 *
 * What this buys, concretely: **every consumer above the dictionary layer codes
 * against `DictStore` now**, and swapping in the OPFS-backed store is a change
 * to one construction site. That is the seam C4a exists to create; the fetches
 * behind it are an implementation detail of one file.
 *
 * What it costs, stated plainly so nobody reads a green suite as a finished
 * cutover: this file is the one remaining `api/dict` caller, so
 * `grep -rn "api/dict" lib/` is not yet empty and **`data.md` D6 is not yet
 * unblocked**. HANDOFF.md carries both greps.
 *
 * Two methods of the frozen interface have no route behind them:
 *
 *   - `readingCount` is answered with a search and a count. Correct, one extra
 *     round trip, and the caller cannot tell.
 *   - `wordsContaining` **throws**. It needs the `chars` table (STACK §5.6),
 *     which is `data.md`'s call and which no route exposes. Returning `[]`
 *     would be a lie a caller cannot distinguish from "no such words", and this
 *     product's whole promise is that it does not say things it cannot support.
 *     Nothing in the app calls it: C4's character sheet takes that list as a
 *     prop for exactly this reason.
 */
import {
  DictRequestError,
  fetchDecomp,
  fetchEntriesResponse,
  fetchHskResponse,
  fetchSearch,
  fetchSegment,
} from './client';
import type { DecompCharacter, DecompStore } from './decomp-store';
import type { SearchOptions, SearchResult } from './search';
import type { SegmentOptions, SegmentResult } from './segment';
import type { DictStatus, DictStore } from './store';
import type { DictEntry, EntryId, HskBand } from './types';

export interface HttpDictStoreOptions {
  /** Origin to prefix. Empty in the browser; set in Node tests. */
  baseUrl?: string;
}

export class HttpDictStore implements DictStore {
  #status: DictStatus = { state: 'absent' };
  #listeners = new Set<(status: DictStatus) => void>();
  readonly #baseUrl: string | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: HttpDictStoreOptions = {}) {
    this.#baseUrl = options.baseUrl;
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

  #set(status: DictStatus): void {
    this.#status = status;
    for (const listener of [...this.#listeners]) listener(status);
  }

  /**
   * Idempotent, and safe to call on every mount — which is what the interface
   * promises and what a component tree with several dictionary surfaces will
   * actually do. The in-flight promise is shared so N mounts make one probe.
   *
   * The probe is the smallest real query: band 1 returns rows if and only if
   * the artifact is built, which is exactly what `components/shell/data-banner.tsx`
   * used to ask with a `HEAD`. C4a deletes that banner and this answers for it.
   */
  open(): Promise<void> {
    if (this.#status.state === 'ready') return Promise.resolve();
    if (this.#opening) return this.#opening;
    this.#set({ state: 'preparing' });
    this.#opening = (async () => {
      try {
        const body = await fetchHskResponse(1, this.#options());
        this.#set({ state: 'ready', version: body.meta.version });
      } catch (error) {
        this.#set({
          state: 'failed',
          // A 503 `dict-data-missing` is the artifact not being there at all;
          // anything else reaching this far is the fetch itself.
          reason: error instanceof DictRequestError && error.dataMissing ? 'import' : 'download',
          message: error instanceof Error ? error.message : 'The dictionary did not answer.',
        });
      } finally {
        this.#opening = undefined;
      }
    })();
    return this.#opening;
  }

  #options() {
    return this.#baseUrl === undefined ? {} : { baseUrl: this.#baseUrl };
  }

  /**
   * Every answer that carries a version moves the store to `ready`.
   *
   * `open()` is the deliberate probe, but a caller that goes straight to a
   * query — the demo seed does, and so does anything that runs before a gate
   * has mounted — would otherwise leave `status` at `absent` while the
   * dictionary was plainly answering. That is not cosmetic: `status.version` is
   * **the version a card is stamped with**, so a card added on that path was
   * written with `dictVersion: 'unknown'`.
   */
  #sawVersion(version: string | undefined): void {
    if (!version) return;
    if (this.#status.state === 'ready' && this.#status.version === version) return;
    this.#set({ state: 'ready', version });
  }

  async entries(ids: readonly EntryId[]): Promise<DictEntry[]> {
    const body = await fetchEntriesResponse(ids, this.#options());
    this.#sawVersion(body.meta.version);
    return body.entries;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const result = await fetchSearch(query, { ...this.#options(), ...options });
    this.#sawVersion(result.dictVersion);
    return result;
  }

  async segment(text: string, options: SegmentOptions = {}): Promise<SegmentResult> {
    return fetchSegment(text, {
      ...this.#options(),
      ...(options.script === undefined ? {} : { script: options.script }),
    });
  }

  async hskBand(
    band: HskBand,
    options: { limit?: number; offset?: number } = {},
  ): Promise<DictEntry[]> {
    /**
     * The route has no paging, so the page is taken here.
     *
     * That is **not** the paging `data.md` asks for — the point of `limit` /
     * `offset` is that a 5,638-entry band never crosses the bridge whole, and
     * this crosses it whole and then slices. It keeps the *signature* honest so
     * `lib/lists/entry-source.ts` can be written against the interface today;
     * the cost moves when the real store lands. Recorded in HANDOFF.md.
     */
    const body = await fetchHskResponse(band, this.#options());
    this.#sawVersion(body.meta.version);
    const offset = options.offset ?? 0;
    const limit = options.limit;
    return limit === undefined
      ? body.entries.slice(offset)
      : body.entries.slice(offset, offset + limit);
  }

  async readingCount(simp: string): Promise<number> {
    const result = await this.search(simp);
    const group = result.groups.find((candidate) => candidate.simp === simp);
    return group?.entries.length ?? 0;
  }

  async wordsContaining(): Promise<DictEntry[]> {
    throw new Error(
      'HttpDictStore cannot answer wordsContaining: it needs the `chars` table (STACK §5.6), ' +
        'which no route exposes. Use the SQLite store (data.md D2/D4).',
    );
  }
}

/** The decomposition half, kept apart because its licence is (data.md D1). */
export class HttpDecompStore implements DecompStore {
  readonly #baseUrl: string | undefined;

  constructor(options: HttpDictStoreOptions = {}) {
    this.#baseUrl = options.baseUrl;
  }

  async decompose(chars: string): Promise<DecompCharacter[]> {
    const characters = await fetchDecomp(
      chars,
      this.#baseUrl === undefined ? {} : { baseUrl: this.#baseUrl },
    );
    return characters.map((character) => ({ char: character.char, entry: character.entry }));
  }
}
