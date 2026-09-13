/**
 * The one `DictStore` implementation (docs/plans/data.md D2, D3).
 *
 * Written entirely against `SqlRunner`, so it knows nothing about whether it is
 * talking to `node:sqlite` in a test, `sqlite-wasm` in a browser worker or the
 * Capacitor plugin on a phone. Everything interesting — routing, ranking,
 * grouping, paging, the segmentation DP — is here or in `lib/dict/rank.ts`, and
 * is therefore written once for all three platforms.
 *
 * **The rule that makes the Capacitor bridge survivable: a `DictStore` method is
 * at most two `SqlRunner.query()` calls, and each call is one batch.** Every
 * call is a JSON round trip (~1–5 ms plus result serialisation), so
 * `tests/unit/dict/store.test.ts` counts them against a spy runner and fails if
 * someone adds a third. The budget:
 *
 * | method | trips | why |
 * |---|---|---|
 * | `open` | 1 | `meta` + the whole `chars` table |
 * | `entries`, `hskBand`, `readingCount` | 1 | |
 * | `wordsContaining` | 2 | the posting list is a BLOB only TypeScript can decode |
 * | `search` | 2 | candidates, then every reading of the page's headwords |
 * | `segment` | 2 | candidate substrings, then the chosen words' entry ids |
 *
 * `wordsContaining` is two where `data.md` D2's table says one; that row is not
 * achievable while `char_words.rowids` is a packed posting list, and the
 * one-trip alternative is an order of magnitude slower. See HANDOFF.md, D2.
 */
import {
  CandidateSet,
  SECTION_LABELS,
  dedupeSections,
  hasCjk,
  materialise,
  pageWindow,
  type GroupCandidate,
  type MatchSource,
} from './rank';
import { decodeRowids } from './artifact';
import { normalizePinyin } from './pinyin';
import {
  MAX_HANZI_PREFIX_IDS,
  charWords,
  hanziExact,
  hanziPrefix,
} from './query/hanzi';
import { MAX_PINYIN_PREFIX_IDS, pinyinExact, pinyinPrefix } from './query/pinyin';
import { hskBandQuery } from './query/hsk';
import {
  entriesByIds,
  entriesByRowids,
  readingsForCount,
  readingsOfHeadwords,
  rowToEntry,
  rowToRank,
  type SqlRow,
} from './query/entries';
import type { SearchOptions, SearchResult, SearchSection } from './search';
import type { SegmentOptions, SegmentResult, SegmentScript } from './segment';
import type { SqlQuery, SqlRunner, SqlValue } from './sql';
import type { DictStatus, DictStore } from './store';
import type { DictEntry, EntryId, HskBand } from './types';

// ---------------------------------------------------------------------------
// What `open()` reads once
// ---------------------------------------------------------------------------

/** The per-character script facts, read whole at `open()`. 14,625 rows. */
export type CharTable = ReadonlyMap<string, { simp: boolean; trad: boolean }>;

export interface DictMetaConstants {
  schemaVersion: number;
  dictVersion: string;
  entryCount: number;
  /** `Math.log()` of these is the DP's unknown-word floor; see `segment.ts`. */
  wordsTotal: Record<SegmentScript, number>;
  maxLen: Record<SegmentScript, number>;
}

export interface OpenedDict {
  meta: DictMetaConstants;
  chars: CharTable;
}

function text(value: SqlValue): string {
  if (typeof value !== 'string') throw new TypeError(`expected TEXT, got ${typeof value}`);
  return value;
}

function int(value: SqlValue): number {
  if (typeof value !== 'number') throw new TypeError(`expected INTEGER, got ${typeof value}`);
  return value;
}

/**
 * `meta` and `chars` in one round trip.
 *
 * `chars` is 14,625 rows of two integers and it is read whole on purpose: it is
 * what keeps `detectScript` **synchronous** after the port, which is what lets
 * `segment()` stay a single pass rather than a per-character await.
 */
export const OPEN_BATCH: readonly SqlQuery[] = [
  { sql: 'SELECT key, value FROM meta' },
  { sql: 'SELECT ch, simp_evidence, trad_evidence FROM chars' },
];

export function readOpenBatch(results: readonly SqlRow[][]): OpenedDict {
  const meta = new Map(results[0].map((row) => [text(row.key), text(row.value)]));
  const required = (key: string): string => {
    const value = meta.get(key);
    if (value === undefined) throw new Error(`the dictionary has no meta.${key}`);
    return value;
  };
  const chars = new Map<string, { simp: boolean; trad: boolean }>();
  for (const row of results[1]) {
    chars.set(text(row.ch), {
      simp: int(row.simp_evidence) === 1,
      trad: int(row.trad_evidence) === 1,
    });
  }
  return {
    meta: {
      schemaVersion: Number(required('schema_version')),
      dictVersion: required('dict_version'),
      entryCount: Number(required('entry_count')),
      wordsTotal: {
        simp: Number(required('words_total_simp')),
        trad: Number(required('words_total_trad')),
      },
      maxLen: {
        simp: Number(required('max_len_simp')),
        trad: Number(required('max_len_trad')),
      },
    },
    chars,
  };
}

/**
 * Which script the text is written in, from the `chars` table.
 *
 * The same shape as `segment.ts`'s `detectScript(index, text)` and the same
 * semantics: a character counts as evidence only where the two scripts disagree
 * about it — 我 and 的 are written the same way in both and say nothing, 學 and
 * 学 each say a great deal — and ties go to simplified, the app default.
 */
export function detectScriptFrom(chars: CharTable, text: string): SegmentScript {
  let simp = 0;
  let trad = 0;
  for (const char of text) {
    if (!hasCjk(char)) continue;
    const facts = chars.get(char);
    if (!facts) continue;
    if (facts.simp) simp += 1;
    if (facts.trad) trad += 1;
  }
  return trad > simp ? 'trad' : 'simp';
}

// ---------------------------------------------------------------------------
// Caching in front of the runner
// ---------------------------------------------------------------------------

/**
 * A small LRU of recent results plus in-flight coalescing.
 *
 * Two identical queries share one promise, so a keystroke that arrives while the
 * previous one is still in the air costs nothing. `core.md` still debounces
 * input; both are needed, because debouncing does not help the second tab, the
 * back button, or a component that mounts twice.
 */
class ResultCache {
  readonly #limit: number;
  readonly #done = new Map<string, unknown>();
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(limit = 64) {
    this.#limit = limit;
  }

  async take<T>(key: string, run: () => Promise<T>, coalesce = true): Promise<T> {
    const hit = this.#done.get(key);
    if (hit !== undefined) {
      // Re-inserting is what makes it least-recently-*used* rather than -added.
      this.#done.delete(key);
      this.#done.set(key, hit);
      return hit as T;
    }
    // A call carrying an `AbortSignal` reads the cache and fills it, but does
    // not *join* an in-flight promise and is not joinable. Sharing one promise
    // between callers with different signals means one caller's abort rejects
    // the other's perfectly live request, and a refcount over participants is
    // more machinery than a debounced search box needs.
    const flying = coalesce ? this.#inFlight.get(key) : undefined;
    if (flying) return flying as Promise<T>;

    const promise = run()
      .then((value) => {
        this.#done.set(key, value);
        while (this.#done.size > this.#limit) {
          const oldest = this.#done.keys().next().value;
          if (oldest === undefined) break;
          this.#done.delete(oldest);
        }
        return value;
      })
      .finally(() => {
        if (coalesce) this.#inFlight.delete(key);
      });
    if (coalesce) this.#inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.#done.clear();
    this.#inFlight.clear();
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface SqliteStoreOptions {
  /**
   * Opens the connection. Called once by `open()`, and never before — a store
   * may be constructed on a page that never looks a word up.
   */
  connect: () => Promise<SqlRunner>;
  /** Status while `connect()` runs; the web store reports download progress. */
  onStatus?: (status: DictStatus) => void;
  cacheSize?: number;
}

export class SqliteDictStore implements DictStore {
  readonly #options: SqliteStoreOptions;
  readonly #listeners = new Set<(status: DictStatus) => void>();
  readonly #cache: ResultCache;
  #status: DictStatus = { state: 'absent' };
  #runner?: SqlRunner;
  #opened?: OpenedDict;
  #opening?: Promise<void>;

  constructor(options: SqliteStoreOptions) {
    this.#options = options;
    this.#cache = new ResultCache(options.cacheSize);
  }

  get status(): DictStatus {
    return this.#status;
  }

  subscribe(listener: (status: DictStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setStatus(status: DictStatus): void {
    this.#status = status;
    this.#options.onStatus?.(status);
    for (const listener of this.#listeners) listener(status);
  }

  /** Idempotent; safe to call on every mount. Concurrent calls share one attempt. */
  async open(): Promise<void> {
    if (this.#opened) return;
    if (this.#opening) return this.#opening;
    this.#setStatus({ state: 'preparing' });
    this.#opening = (async () => {
      try {
        const runner = await this.#options.connect();
        const results = await runner.query(OPEN_BATCH);
        const opened = readOpenBatch(results as SqlRow[][]);
        this.#runner = runner;
        this.#opened = opened;
        this.#setStatus({ state: 'ready', version: opened.meta.dictVersion });
      } catch (error) {
        this.#setStatus({
          state: 'failed',
          reason: 'corrupt',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        this.#opening = undefined;
      }
    })();
    return this.#opening;
  }

  /** Everything `open()` read, for the callers that need the constants. */
  get opened(): OpenedDict | undefined {
    return this.#opened;
  }

  async close(): Promise<void> {
    this.#cache.clear();
    const runner = this.#runner;
    this.#runner = undefined;
    this.#opened = undefined;
    this.#setStatus({ state: 'absent' });
    await runner?.close();
  }

  #ready(): { runner: SqlRunner; opened: OpenedDict } {
    if (!this.#runner || !this.#opened) {
      throw new Error('the dictionary is not open — await store.open() first');
    }
    return { runner: this.#runner, opened: this.#opened };
  }

  async #run(batch: readonly SqlQuery[], signal?: AbortSignal): Promise<SqlRow[][]> {
    const { runner } = this.#ready();
    return (await runner.query(batch, signal)) as SqlRow[][];
  }

  // -------------------------------------------------------------------------

  async entries(ids: readonly EntryId[]): Promise<DictEntry[]> {
    if (ids.length === 0) return [];
    return this.#cache.take(`entries:${ids.join(',')}`, async () => {
      const [rows] = await this.#run([entriesByIds(ids)]);
      const byId = new Map(rows.map((row) => [text(row.id), rowToEntry(row)]));
      // In the order asked for, unknown ids dropped — `getEntries`'s contract.
      const out: DictEntry[] = [];
      for (const id of ids) {
        const entry = byId.get(id);
        if (entry) out.push(entry);
      }
      return out;
    });
  }

  async hskBand(
    band: HskBand,
    options: { limit?: number; offset?: number } = {},
  ): Promise<DictEntry[]> {
    const key = `hsk:${band}:${options.limit ?? ''}:${options.offset ?? ''}`;
    return this.#cache.take(key, async () => {
      const [rows] = await this.#run([hskBandQuery(band, options.limit, options.offset)]);
      return rows.map(rowToEntry);
    });
  }

  /**
   * How many *readings* a simplified headword has — not how many rows.
   *
   * CC-CEDICT keeps a row per traditional variant and per capitalised proper
   * noun, so 后, 里, 面, 出 and 云 all have several entries and one reading each.
   * `polyphone` is a claim about pronunciation, so counting rows would put the
   * warning on almost every common character and teach the learner to ignore it.
   */
  async readingCount(simp: string): Promise<number> {
    return this.#cache.take(`readings:${simp}`, async () => {
      const [rows] = await this.#run([readingsForCount(simp)]);
      const readings = new Set<string>();
      for (const row of rows) readings.add(text(row.pinyin_num).toLowerCase().replace(/\s+/g, ''));
      return readings.size;
    });
  }

  /**
   * Every headword containing `ch`, most frequent first.
   *
   * Two round trips, and the only method that needs them: the posting list is a
   * delta-varint BLOB, so the rowids are not known until TypeScript has decoded
   * the first result. It is the character sheet's panel, opened on a tap, not
   * something on the keystroke path.
   */
  async wordsContaining(
    ch: string,
    options: { script?: SegmentScript; limit?: number } = {},
  ): Promise<DictEntry[]> {
    const script = options.script ?? 'simp';
    const limit = options.limit ?? 50;
    return this.#cache.take(`contains:${script}:${ch}:${limit}`, async () => {
      const [rows] = await this.#run([charWords(ch, script)]);
      const row = rows[0];
      if (!row) return [];
      const blob = row.rowids;
      if (!(blob instanceof Uint8Array)) {
        throw new TypeError('char_words.rowids did not come back as a BLOB');
      }
      const rowids = decodeRowids(blob).slice(0, limit);
      if (rowids.length === 0) return [];
      const [entryRows] = await this.#run([entriesByRowids(rowids)]);
      return entryRows.map(rowToEntry);
    });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Hanzi and pinyin search (D2). The English half is D3's; until it lands a
   * pinyin-parsing query answers with its pinyin section alone.
   *
   * Two round trips: one batch of candidate queries, then one batch fetching
   * every reading of the headwords **this page shows**. That is the reason the
   * candidate queries project only `RANK_COLUMNS`: ranking, deduping and paging
   * all happen on eight small fields, and the glosses and pinyin of at most
   * fifty groups cross the bridge afterwards.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const { opened } = this.#ready();
    const { signal } = options;
    const trimmed = query.trim();
    const key = `search:${trimmed}:${options.limit ?? ''}:${options.cursor ?? ''}`;
    return this.#cache.take(key, async () => {
      if (!trimmed) return this.#emptyResult(trimmed, 'english', opened.meta.dictVersion);

      if (hasCjk(trimmed)) {
        const batch = [
          hanziExact(trimmed),
          hanziPrefix(trimmed, 'simp', MAX_HANZI_PREFIX_IDS),
          hanziPrefix(trimmed, 'trad', MAX_HANZI_PREFIX_IDS),
        ];
        const [exact, bySimp, byTrad] = await this.#run(batch, signal);
        const candidates = new CandidateSet();
        candidates.addAll(exact.map(rowToRank), 0);
        candidates.addAll(bySimp.map(rowToRank), 1);
        candidates.addAll(byTrad.map(rowToRank), 1);
        return this.#page(
          trimmed,
          'hanzi',
          [{ source: 'hanzi', candidates: candidates.ordered() }],
          options,
          opened.meta.dictVersion,
          signal,
        );
      }

      const pinyin = normalizePinyin(trimmed);
      if (!pinyin.fullyParsed) {
        // English-only. D3 fills this in; until then there is nothing to say.
        return this.#emptyResult(trimmed, 'english', opened.meta.dictVersion);
      }

      const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
      const batch: SqlQuery[] = [];
      if (toned) batch.push(pinyinExact(pinyin.toned, true));
      batch.push(pinyinExact(pinyin.toneless, false));
      batch.push(
        pinyinPrefix(toned ? pinyin.toned : pinyin.toneless, toned, MAX_PINYIN_PREFIX_IDS),
      );
      const results = await this.#run(batch, signal);
      const candidates = new CandidateSet();
      let at = 0;
      // Tone-exact beats toneless beats prefix (PLAN.md §3.2).
      if (toned) candidates.addAll(results[at++].map(rowToRank), 0);
      candidates.addAll(results[at++].map(rowToRank), 1);
      candidates.addAll(results[at].map(rowToRank), 2);
      return this.#page(
        trimmed,
        'pinyin+english',
        [{ source: 'pinyin', candidates: candidates.ordered() }],
        options,
        opened.meta.dictVersion,
        signal,
      );
    }, signal === undefined);
  }

  #emptyResult(query: string, route: SearchResult['route'], dictVersion: string): SearchResult {
    return { query, route, groups: [], sections: [], total: 0, dictVersion, offset: 0 };
  }

  /**
   * Dedupe across sections, page, then fetch the page's entries.
   *
   * Deduping before paging is what stops page 2 repeating page 1; materialising
   * after paging is what keeps the second round trip to ≤50 headwords. Both
   * rules are `lib/dict/rank.ts`'s and the JSON implementation follows the same
   * order, so the two can be compared group-for-group.
   */
  async #page(
    query: string,
    route: SearchResult['route'],
    ordered: readonly { source: MatchSource; candidates: GroupCandidate[] }[],
    options: SearchOptions,
    dictVersion: string,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const deduped = dedupeSections(ordered.map((part) => part.candidates));
    const window = pageWindow(
      deduped.map((groups) => groups.length),
      options,
    );
    const pages = deduped.map((groups, i) =>
      groups.slice(window.slices[i].start, window.slices[i].end),
    );
    const simps = [...new Set(pages.flat().map((candidate) => candidate.simp))];

    const readings = new Map<string, DictEntry[]>();
    if (simps.length > 0) {
      const [rows] = await this.#run([readingsOfHeadwords(simps)], signal);
      for (const row of rows) {
        const entry = rowToEntry(row);
        const list = readings.get(entry.simp);
        if (list) list.push(entry);
        else readings.set(entry.simp, [entry]);
      }
    }

    const sections: SearchSection[] = [];
    pages.forEach((page, i) => {
      if (page.length === 0) return;
      const source = ordered[i].source;
      sections.push({
        source,
        label: SECTION_LABELS[source],
        groups: page.map((candidate) =>
          materialise(
            candidate,
            // 干 splits into three traditional headwords sharing one simplified
            // form, so the `simp` query is filtered down to this exact headword.
            (readings.get(candidate.simp) ?? []).filter((entry) => entry.trad === candidate.trad),
            source,
          ),
        ),
      });
    });

    return {
      query,
      route,
      groups: sections.flatMap((part) => part.groups),
      sections,
      total: window.total,
      dictVersion,
      offset: window.offset,
      ...(window.nextCursor === undefined ? {} : { nextCursor: window.nextCursor }),
    };
  }

  /**
   * The segmenter is D3's: `lib/dict/segment.ts` is inverted there, and the
   * `words` and `chars` tables it needs are already in the artifact.
   *
   * It rejects rather than returning an empty result, because an empty
   * segmentation is a legitimate answer for an empty string and a caller cannot
   * tell "no tokens" from "not built yet".
   */
  segment(text: string, options?: SegmentOptions): Promise<SegmentResult> {
    void text;
    void options;
    return Promise.reject(
      new Error('DictStore.segment arrives with the segmenter inversion in data.md D3'),
    );
  }
}
