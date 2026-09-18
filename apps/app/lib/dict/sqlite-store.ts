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
 * | `resolve` | 1 | hanzi, toned keys and toneless keys in one batch |
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
  glossTier,
  hasCjk,
  lemma,
  lemmas,
  materialise,
  pageWindow,
  stemToken,
  type GroupCandidate,
  type MatchSource,
} from './rank';
import { SCHEMA_VERSION, decodeRowids } from './artifact';
import { DictOpenError } from './open-error';
import { normalizePinyin } from './pinyin';
import {
  MAX_HANZI_PREFIX_IDS,
  charWords,
  hanziExact,
  hanziPrefix,
} from './query/hanzi';
import { MAX_PINYIN_PREFIX_IDS, pinyinExact, pinyinPrefix } from './query/pinyin';
import { MAX_GLOSS_CANDIDATES, buildMatch, glossCandidates } from './query/gloss';
import { candidateSubstrings, readingsOfWords, wordCandidates } from './query/segment';
import { hskBandQuery } from './query/hsk';
import { hanziExactMany, pinyinExactMany } from './query/resolve';
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
import { attachIds, planSegments, type SegmentOptions, type SegmentResult, type SegmentScript } from './segment';
import type { SqlQuery, SqlRunner, SqlValue } from './sql';
import { checkResolveLimits, planResolve } from './resolve';
import type { DictStatus, DictStore, ResolveResult, ResolvedWord } from './store';
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

/** `text` under another name, for the places where a parameter shadows it. */
const text_ = text;

/**
 * Flatten a chunked result set back into one rowid-ordered list, deduped.
 *
 * `ORDER BY rowid` orders rows *within* a statement, and a chunked query is
 * several statements — so the concatenation is only globally ordered by
 * accident of how the chunks were cut. Rowid order IS frequency order (D1), and
 * every caller of these queries depends on it, so it is restored explicitly
 * rather than reasoned about per call site. The dedupe matters for the one query
 * that binds its list twice (`simp IN (…) OR trad IN (…)`), where an entry can
 * be returned by two different chunks.
 */
function byRowid(results: readonly SqlRow[][]): SqlRow[] {
  const seen = new Set<number>();
  const rows: SqlRow[] = [];
  for (const row of results.flat()) {
    const rowid = int(row.rowid);
    if (seen.has(rowid)) continue;
    seen.add(rowid);
    rows.push(row);
  }
  return rows.sort((a, b) => int(a.rowid) - int(b.rowid));
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
/** Freeze a result before it enters the cache. Arrays and plain objects only. */
function freezeShallow<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value) as T;
  if (value && typeof value === 'object') return Object.freeze(value) as T;
  return value;
}

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
        // Frozen before it is stored, because a cache hands out the *same*
        // object to every later caller: one consumer calling `.sort()` on a
        // returned entry list, or emptying it, would poison every subsequent
        // answer for the life of the session. Shallow — the entries themselves
        // are still mutable, and a consumer that reaches into one deserves what
        // it gets — but it stops the whole class of accidents that look like a
        // dictionary bug.
        this.#done.set(key, freezeShallow(value));
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
// The English gloss route (docs/plans/data.md D3)
// ---------------------------------------------------------------------------

/**
 * One query word can have two lookup forms, and the pool is their **union**.
 *
 * `englishGroups` computes `forms = {stemToken(word), lemma(word)}` over the
 * *already lemmatised* word, which collapses to a singleton almost always — but
 * not for a plural of a plural. `lemmas('mens')` is `['men']`, and `men` is
 * itself an `IRREGULAR` key, so its forms are `{men, man}` and today's code
 * unions both posting lists.
 *
 * FTS5 could say that as `("men" OR "man")`, and D3 forbids ` OR ` in a MATCH
 * string outright — the guard against an irregular-plural OR group creeping into
 * the *ranked* path and widening recall. So the union is expressed as one
 * statement per form combination instead, and the results are unioned in
 * TypeScript. That is exactly equal: an id matching every word under some choice
 * of forms is in that choice's intersection, and every choice's intersection is
 * inside the union-of-forms intersection.
 *
 * The combinations are `prod(|forms_i|)`, which is 1 for every ordinary query.
 * Above four the fallback is the first form of each word, recorded rather than
 * silent, because a three-word query with two double-plural misspellings is not
 * worth a sixteen-statement batch.
 */
const MAX_FORM_COMBINATIONS = 4;

interface EnglishPlan {
  queryWords: string[];
  batch: SqlQuery[];
  /** How many of `batch` are the ranked path. */
  rankedStatements: number;
  /** Which statements `isGlossToken` reads — possibly ones the ranked path already ran. */
  glossTokenAt: number[];
}

/** Every combination of one form per query word, at most `MAX_FORM_COMBINATIONS`. */
function formCombinations(queryWords: readonly string[]): string[][] {
  const perWord = queryWords.map((word) => [...new Set([stemToken(word), lemma(word)])]);
  const total = perWord.reduce((product, forms) => product * forms.length, 1);
  // Above the bound, the first form of each word. Reaching it needs three query
  // words that are each a plural of an irregular plural ("mens womens peoples"),
  // and the consequence is that one of the two form-unions is not taken — the
  // same shape of narrowing today's code has everywhere else.
  if (total > MAX_FORM_COMBINATIONS) return [perWord.map((forms) => forms[0])];
  let combos: string[][] = [[]];
  for (const forms of perWord) {
    combos = combos.flatMap((prefix) => forms.map((form) => [...prefix, form]));
  }
  return combos;
}

/**
 * The statements an English query needs, or null when nothing survives cleaning.
 *
 * `isGlossToken` gets **its own statements at its own limit**, riding in the same
 * batch. It is the `sun`/`can`/`women`-versus-`shi` rule that decides which
 * section leads, and it is not the ranked path: sharing a smaller cap with it
 * would make it return false where it returns true today and silently reroute
 * queries. It runs only for a single Latin token of three letters or more, so it
 * is not on the path of a typical multi-word English query.
 */
function englishPlan(query: string): EnglishPlan | null {
  const queryWords = lemmas(query);
  if (queryWords.length === 0) return null;
  const combos = formCombinations(queryWords);
  const batch: SqlQuery[] = [];
  for (const combo of combos) {
    const match = buildMatch(combo);
    if (match) batch.push(glossCandidates(match, MAX_GLOSS_CANDIDATES));
  }
  if (batch.length === 0) return null;
  const rankedStatements = batch.length;

  const token = query.trim().toLowerCase();
  const glossTokenAt: number[] = [];
  if (/^[a-z']{3,}$/.test(token)) {
    // `forms` over the RAW token, not the lemmatised one — `isGlossToken`'s own
    // spelling, which is what gives `women` two forms where the ranked path has
    // one.
    for (const form of new Set([stemToken(token), lemma(token)])) {
      const match = buildMatch([form]);
      if (!match) continue;
      // A single-word query's ranked statement is usually the SAME statement:
      // `plan` ranks `"plan"` and probes `"plan"`. Running it twice costs a
      // second 5,000-row scan per keystroke for a result that is already in
      // hand — measured at roughly double the gloss cost on a common token —
      // so the probe reuses the ranked statement's index when it matches.
      const existing = batch.findIndex(
        (statement) => statement.sql === glossCandidates(match, MAX_GLOSS_CANDIDATES).sql &&
          statement.params?.[0] === match,
      );
      if (existing !== -1) {
        glossTokenAt.push(existing);
        continue;
      }
      glossTokenAt.push(batch.length);
      batch.push(glossCandidates(match, MAX_GLOSS_CANDIDATES));
    }
  }
  return { queryWords, batch, rankedStatements, glossTokenAt };
}

/** A gloss candidate row → the facts ranking needs, plus the glosses `glossTier` reads. */
function toGlossCandidate(row: SqlRow): { facts: ReturnType<typeof rowToRank>; glosses: string[] } {
  return { facts: rowToRank(row), glosses: JSON.parse(text(row.glosses)) as string[] };
}

function englishCandidates(plan: EnglishPlan, results: readonly SqlRow[][]): GroupCandidate[] {
  const candidates = new CandidateSet();
  const seen = new Set<string>();
  // Union across form combinations, in rowid order within each. Deduped by id,
  // because two combinations can admit the same row.
  for (let i = 0; i < plan.rankedStatements; i += 1) {
    for (const row of results[i] ?? []) {
      const { facts, glosses } = toGlossCandidate(row);
      if (seen.has(facts.id)) continue;
      seen.add(facts.id);
      const tier = glossTier({ glosses } as DictEntry, plan.queryWords);
      if (!Number.isFinite(tier)) continue;
      candidates.add(facts, tier);
    }
  }
  return candidates.ordered();
}

/**
 * True when the raw query is itself an English **word** — the `sun`/`can`/`women`
 * rule.
 *
 * "Appears somewhere in a gloss" is not that test. `shi` appears as a token in 39
 * glosses ("jiang shi" for 殭屍, "lüshi form" for 排律) because CC-CEDICT
 * romanises inside its English, and taking that as an English word buried 是, 事,
 * 十 — every HSK 1–2 reading of the syllable — under the reserved rows of a
 * section that had nothing a learner typing `shi` wanted. So the query has to be
 * a whole *sense* of some entry (tier 0 or 1), which is what "the English word"
 * means: 太阳 is "sun", 女人 is "woman", and no entry is "shi".
 *
 * "First candidate that matches" is only meaningful in frequency order, which
 * rowid order is (D1). The statement carries no `ORDER BY`: FTS5 scans ascending
 * by rowid and `data.md` D4 took the clause out because the sort costs 1,117 ms
 * in wasm. What holds the invariant now is a pair of assertions rather than a
 * clause — `tests/unit/dict/gloss-order.test.ts` on the artifact, and
 * `tests/e2e/d/dict-wasm.spec.ts` on the wasm runner. This walk must still not
 * be reordered by relevance.
 */
function isGlossToken(plan: EnglishPlan, results: readonly SqlRow[][]): boolean {
  for (const i of plan.glossTokenAt) {
    for (const row of results[i] ?? []) {
      const { glosses } = toGlossCandidate(row);
      if (glossTier({ glosses } as DictEntry, plan.queryWords) <= 1) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** What `connect()` is handed, so a slow open can say how far along it is. */
export interface ConnectContext {
  /**
   * Report import progress. Ignored once the attempt has settled, so a late
   * chunk cannot drag a `ready` store back to `preparing`.
   *
   * This is the inbound half of the status model and it is why `connect` takes
   * an argument at all: `onStatus` below is a *listener*, and D4's first web
   * load is a 43 MB download that `core.md` draws a determinate bar in front of.
   * A runner with no way to say "17 of 43 MB" leaves that bar indeterminate.
   */
  progress: (received: number, total?: number) => void;
}

export interface SqliteStoreOptions {
  /**
   * Opens the connection. Called once by `open()`, and never before — a store
   * may be constructed on a page that never looks a word up.
   */
  connect: (context: ConnectContext) => Promise<SqlRunner>;
  /** Status while `connect()` runs; the web store reports download progress. */
  onStatus?: (status: DictStatus) => void;
  /**
   * Whether *this* open should show on the status, asked once per `open()`.
   *
   * Defaults to yes, and the only caller that says no is the browser store's
   * **probe** — `WasmDictStoreHandle.openStored()`, which opens whatever this
   * origin has already stored and fetches nothing. Announcing that would put
   * `preparing` on screen, which is a card reading *"Getting the dictionary …
   * you can carry on — this finishes in the background"* over an open that is
   * downloading nothing and will be over in a moment; and it would take
   * `dict-start` out from under a learner's finger every time some other
   * surface mounted and probed.
   *
   * A quiet open reports only its **success**. Its failure is the caller's to
   * interpret: "nothing stored" is a state, not something to put on a screen,
   * and `openStored()` is what decides between the ask and a real failure.
   */
  announceOpen?: () => boolean;
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
    // Asked once, here, and carried through the attempt: a flag read again
    // later could be answered by a *different* open's caller.
    const announce = this.#options.announceOpen?.() ?? true;
    if (announce) this.#setStatus({ state: 'preparing' });
    // The `.finally` is attached OUTSIDE the async body on purpose. An async
    // function runs synchronously up to its first suspension, so a `connect()`
    // that throws before ever awaiting would reach an inner `finally` *before*
    // the assignment below — latching a rejected promise into `#opening`
    // forever, and wedging every later `open()` on a store that could have
    // recovered. A `.finally` callback is always a microtask, so by the time it
    // runs the assignment has happened.
    // The tracked promise is the CHAINED one, not the raw attempt: clearing the
    // slot by comparing against the attempt would never match, and a failed
    // open would latch its rejection into `#opening` — the same wedge in a new
    // place, and one a test caught.
    const tracked: Promise<void> = this.#attemptOpen(announce).finally(() => {
      if (this.#opening === tracked) this.#opening = undefined;
    });
    this.#opening = tracked;
    return tracked;
  }

  async #attemptOpen(announce: boolean): Promise<void> {
    let runner: SqlRunner | undefined;
    let settled = false;
    const context: ConnectContext = {
      progress: (received, total) => {
        if (settled || !announce) return;
        this.#setStatus({
          state: 'preparing',
          received,
          ...(total === undefined ? {} : { total }),
        });
      },
    };
    try {
      runner = await this.#options.connect(context);
      const results = await runner.query(OPEN_BATCH);
      const opened = readOpenBatch(results as SqlRow[][]);
      // The artifact says which schema it is, and a store that reads a file
      // built by a different `SCHEMA_VERSION` answers confidently and wrongly.
      // D4 distinguishes the four failure reasons properly — it is the phase
      // that fetches bytes and can tell a truncated download from someone
      // else's database — but the check belongs here, where every runner gets
      // it for free.
      if (opened.meta.schemaVersion !== SCHEMA_VERSION) {
        throw new DictOpenError(
          'corrupt',
          `the dictionary is schema ${opened.meta.schemaVersion}, this build reads ${SCHEMA_VERSION}`,
        );
      }
      this.#runner = runner;
      this.#opened = opened;
      this.#setStatus({ state: 'ready', version: opened.meta.dictVersion });
    } catch (error) {
      // Close what was opened. On OPFS the pool holds an exclusive lock per
      // origin and on Capacitor the plugin holds a native handle, so a leaked
      // connection is not garbage — it is a retry that can never succeed.
      if (runner) await runner.close().catch(() => {});
      // D4 refines the four reasons, and this is where it lands: a runner that
      // fetched bytes knows whether the download was short, the import failed,
      // storage refused it, or the file simply is not this dictionary. A runner
      // that cannot tell (the Node one has none of those failure modes) reports
      // the one that means "the file did not open as this dictionary".
      //
      // A **quiet** open reports nothing: a probe that finds no dictionary has
      // not failed at anything the learner needs told about, and putting
      // `failed` on screen for the instant before `openStored()`'s `close()`
      // puts it back to `absent` is a failure card that flashes for no reason.
      if (announce) {
        this.#setStatus({
          state: 'failed',
          reason: error instanceof DictOpenError ? error.reason : 'corrupt',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      settled = true;
    }
  }

  /** Everything `open()` read, for the callers that need the constants. */
  get opened(): OpenedDict | undefined {
    return this.#opened;
  }

  async close(): Promise<void> {
    // A `close()` racing a pending `open()` used to read `#runner` before the
    // continuation had assigned it: the connection leaked and the store flipped
    // back to `ready` a moment after being closed. Waiting for the attempt to
    // settle — its failure is not this call's problem — makes close mean closed.
    if (this.#opening) await this.#opening.catch(() => {});
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
      const results = await this.#run(entriesByIds(ids));
      const byId = new Map(results.flat().map((row) => [text(row.id), rowToEntry(row)]));
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
      return byRowid(await this.#run(entriesByRowids(rowids))).map(rowToEntry);
    });
  }

  /**
   * Bulk headword resolution for the list importer (`wave-zero.md` §8a, §8b).
   *
   * The rule is `abe6793`'s and `planResolve` holds it; this is the SQL that
   * executes the plan. **One round trip for the whole paste** — the hanzi
   * words, the toned keys and the toneless keys are three statements in one
   * batch — which is why the member is bulk rather than per-word: on the OPFS
   * worker and the Capacitor bridge a 300-line paste would otherwise be 300
   * JSON round trips (§8b, "Why bulk").
   *
   * Every match is **exact**. `search`'s prefix scans would make 打 mean 打算,
   * which is right for someone typing and wrong for a list.
   *
   * `rowid` order is frequency order (`data.md` D1), so the candidates arrive
   * ranked and `abe6793`'s hand-written `compareEntries` is not ported: the
   * comparator existed to put the two scripts' index lists back in order after
   * joining them, and one `ORDER BY rowid` over both columns does that.
   */
  async resolve(
    words: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ResolveResult> {
    const { opened } = this.#ready();
    const { signal } = options;
    // Before the cache, for the reason `search` states: a cached answer to a
    // superseded request is still an answer the caller asked to stop caring
    // about.
    signal?.throwIfAborted();
    // Before the cache for a second reason too — a rejection must not depend on
    // whether an identical request happens to be warm.
    checkResolveLimits(words);
    const asks = planResolve(words);

    // An empty ask is answered, not refused: nothing was asked about, so
    // nothing is the true answer and it costs no round trip. This is *not* the
    // empty-result stub the freeze existed to forbid — that one answered a real
    // paste with nothing. `resolve(['打算'])` returns 打算 or the dictionary is
    // broken, and `tests/unit/dict/resolve.test.ts` asserts exactly that.
    if (asks.length === 0) return { dictVersion: opened.meta.dictVersion, results: [] };

    return this.#cache.take(
      `resolve:${asks.map((ask) => ask.word).join(' ')}`,
      async () => {
        const hanzi = [...new Set(asks.filter((ask) => ask.kind === 'hanzi').map((a) => a.word))];
        const tonedKeys = [...new Set(asks.flatMap((ask) => (ask.toned ? [ask.toned] : [])))];
        const tonelessKeys = [
          ...new Set(asks.flatMap((ask) => (ask.toneless ? [ask.toneless] : []))),
        ];

        // Three groups, one batch, and the statement counts are remembered
        // because chunking makes them variable: a paste of 1,200 hanzi words is
        // three hanzi statements, not one, and the reader below has to know
        // where each group's results end.
        const hanziQueries = hanzi.length > 0 ? hanziExactMany(hanzi) : [];
        const tonedQueries = tonedKeys.length > 0 ? pinyinExactMany(tonedKeys, true) : [];
        const tonelessQueries =
          tonelessKeys.length > 0 ? pinyinExactMany(tonelessKeys, false) : [];
        const batch = [...hanziQueries, ...tonedQueries, ...tonelessQueries];
        // Nothing resolvable in the whole paste — every line was English or
        // junk. Still a real answer, and still no round trip.
        if (batch.length === 0) {
          return {
            dictVersion: opened.meta.dictVersion,
            results: asks.map((ask) => ({ word: ask.word, via: 'none' as const, entries: [] })),
          };
        }

        const results = await this.#run(batch, signal);
        let at = 0;
        const hanziRows = byRowid(results.slice(at, (at += hanziQueries.length)));
        const tonedRows = byRowid(results.slice(at, (at += tonedQueries.length)));
        const tonelessRows = byRowid(results.slice(at, at + tonelessQueries.length));

        // Bucketed by what the word was asked *as*. A hanzi row is filed under
        // both of its spellings, which is how a simplified list and a
        // traditional one resolve alike (§8b, rule 1) — and why the two are
        // deduped per bucket rather than globally: 你好's `simp` and `trad` are
        // the same string, so the row would otherwise be dropped from its own
        // bucket the second time it is filed.
        const byHanzi = new Map<string, DictEntry[]>();
        for (const row of hanziRows) {
          const entry = rowToEntry(row);
          for (const spelling of new Set([text(row.simp), text(row.trad)])) {
            const bucket = byHanzi.get(spelling);
            if (bucket) bucket.push(entry);
            else byHanzi.set(spelling, [entry]);
          }
        }
        const byKey = (rows: readonly SqlRow[], column: string): Map<string, DictEntry[]> => {
          const out = new Map<string, DictEntry[]>();
          for (const row of rows) {
            const key = row[column];
            // NULL is the `xx5` no-known-reading case, which `IN` never matches
            // anyway; the guard is here so a schema that stopped guaranteeing
            // that would be a dropped row rather than a thrown TypeError.
            if (typeof key !== 'string') continue;
            const bucket = out.get(key);
            const entry = rowToEntry(row);
            if (bucket) bucket.push(entry);
            else out.set(key, [entry]);
          }
          return out;
        };
        const byToned = byKey(tonedRows, 'py_toned');
        const byToneless = byKey(tonelessRows, 'py_toneless');

        return {
          dictVersion: opened.meta.dictVersion,
          results: asks.map((ask): ResolvedWord => {
            if (ask.kind === 'hanzi') {
              const entries = byHanzi.get(ask.word) ?? [];
              return { word: ask.word, via: entries.length > 0 ? 'hanzi' : 'none', entries };
            }
            if (ask.kind === 'pinyin') {
              // Tone-exact first, toneless as the fallback — and the fallback
              // only when the exact answer is *empty*, never merged into it.
              // `da3suan4` must stay 打算 alone where `dasuan` may carry more.
              const exact = ask.toned ? (byToned.get(ask.toned) ?? []) : [];
              const entries =
                exact.length > 0 ? exact : (byToneless.get(ask.toneless ?? '') ?? []);
              return { word: ask.word, via: entries.length > 0 ? 'pinyin' : 'none', entries };
            }
            return { word: ask.word, via: 'none', entries: [] };
          }),
        };
      },
      signal === undefined,
    );
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
    // Before the cache, not after: a cached answer to a superseded keystroke is
    // still an answer the caller asked to stop caring about, and a call that
    // rejects when cold and resolves when warm is the worst kind of flake.
    signal?.throwIfAborted();
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
      const english = englishPlan(trimmed);
      if (!pinyin.fullyParsed) {
        if (!english) return this.#emptyResult(trimmed, 'english', opened.meta.dictVersion);
        const rows = await this.#run(english.batch, signal);
        return this.#page(
          trimmed,
          'english',
          [{ source: 'english', candidates: englishCandidates(english, rows) }],
          options,
          opened.meta.dictVersion,
          signal,
        );
      }

      // Both sections always run; only their order is in question, and the loser
      // still shows — that is what makes `he` answer with 和 *and* 他.
      const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
      const batch: SqlQuery[] = [];
      if (toned) batch.push(pinyinExact(pinyin.toned, true));
      batch.push(pinyinExact(pinyin.toneless, false));
      batch.push(
        pinyinPrefix(toned ? pinyin.toned : pinyin.toneless, toned, MAX_PINYIN_PREFIX_IDS),
      );
      const pinyinStatements = batch.length;
      if (english) batch.push(...english.batch);
      const results = await this.#run(batch, signal);
      const candidates = new CandidateSet();
      let at = 0;
      // Tone-exact beats toneless beats prefix (PLAN.md §3.2).
      if (toned) candidates.addAll(results[at++].map(rowToRank), 0);
      candidates.addAll(results[at++].map(rowToRank), 1);
      candidates.addAll(results[at].map(rowToRank), 2);

      const asPinyin = { source: 'pinyin' as MatchSource, candidates: candidates.ordered() };
      const asEnglish = {
        source: 'english' as MatchSource,
        candidates: english ? englishCandidates(english, results.slice(pinyinStatements)) : [],
      };
      const ordered =
        english && isGlossToken(english, results.slice(pinyinStatements))
          ? [asEnglish, asPinyin]
          : [asPinyin, asEnglish];
      return this.#page(
        trimmed,
        'pinyin+english',
        toned ? [asPinyin, asEnglish] : ordered,
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
      for (const row of byRowid(await this.#run(readingsOfHeadwords(simps), signal))) {
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
   * Segment a passage (D3).
   *
   * Two round trips. The first batch asks `words` for the frequency of every
   * ≤16-character substring of every hanzi run, **once per script**; the second
   * fetches the readings of the words the DP actually chose. `detectScript` needs
   * no trip at all, because `open()` already read the whole `chars` table — which
   * is the reason it did.
   *
   * The candidate map spans both scripts with the chosen one winning on
   * collision. That is `segment.ts`'s own `primary.get(word) ?? secondary.get(word)`
   * fallback, and a regression case depends on it: 學習 is a traditional headword,
   * so `segment('學習', { script: 'simp' })` finds it only that way.
   */
  async segment(text: string, options: SegmentOptions = {}): Promise<SegmentResult> {
    const { opened } = this.#ready();
    const key = `segment:${options.script ?? ''}:${text}`;
    return this.#cache.take(key, async () => {
      const script = options.script ?? detectScriptFrom(opened.chars, text);
      const stats = {
        logTotal: Math.log(opened.meta.wordsTotal[script] || 1),
        maxLen: opened.meta.maxLen[script],
      };

      const runs: string[] = [];
      let run = '';
      for (const char of text) {
        if (hasCjk(char)) run += char;
        else if (run) {
          runs.push(run);
          run = '';
        }
      }
      if (run) runs.push(run);

      const substrings = candidateSubstrings(runs);
      const candidates = new Map<string, number>();
      if (substrings.length > 0) {
        const other: SegmentScript = script === 'simp' ? 'trad' : 'simp';
        // The chosen script's statements come second, so its frequency wins on
        // a collision — the map is written in the order the fallback resolves.
        // Each script's list is chunked, so the split is `otherChunks` results
        // followed by `scriptChunks` results, all in ONE batch and therefore one
        // round trip.
        const forOther = wordCandidates(other, substrings);
        const forScript = wordCandidates(script, substrings);
        const results = await this.#run([...forOther, ...forScript]);
        for (const row of results.slice(0, forOther.length).flat()) {
          candidates.set(text_(row.word), int(row.freq));
        }
        for (const row of results.slice(forOther.length).flat()) {
          candidates.set(text_(row.word), int(row.freq));
        }
      }

      const plan = planSegments(text, { script, stats, freqOf: (word) => candidates.get(word) });
      if (plan.words.length === 0) return attachIds(plan, () => []);

      const bySimp = new Map<string, EntryId[]>();
      const byTrad = new Map<string, EntryId[]>();
      // Deduped and re-sorted by rowid: the statement is chunked and binds its
      // list TWICE (`simp IN (…) OR trad IN (…)`), so an entry whose `simp`
      // falls in one chunk and whose `trad` in another is returned by both —
      // 着 came back with eight readings instead of four, which the
      // 20,000-character test caught the moment it was written.
      for (const row of byRowid(await this.#run(readingsOfWords(plan.words)))) {
        const entry = rowToEntry(row);
        (bySimp.get(entry.simp) ?? bySimp.set(entry.simp, []).get(entry.simp) as EntryId[]).push(entry.id);
        (byTrad.get(entry.trad) ?? byTrad.set(entry.trad, []).get(entry.trad) as EntryId[]).push(entry.id);
      }
      const primary = script === 'simp' ? bySimp : byTrad;
      const secondary = script === 'simp' ? byTrad : bySimp;
      return attachIds(plan, (word) => primary.get(word) ?? secondary.get(word) ?? []);
    });
  }
}
