/**
 * `data/dict.json`, parsed, and the seven indexes over it — **build side only**
 * (docs/plans/data.md D6).
 *
 * This is `lib/dict/load.ts` and `lib/dict/index.ts`, moved. D6 says both are
 * "deleted with the routes", and out of the application they are: nothing the
 * app ships parses 35 MB of JSON any more, `DictStore` over the SQLite artifact
 * answers every lookup on every platform, and D6's acceptance criterion 2 — no
 * `node:fs` outside `scripts/`, `tests/`, `lib/server/` and
 * `lib/dict/runners/node.ts` — holds.
 *
 * Deleting the *code* would have broken `pnpm data`. `scripts/build-data.ts`
 * builds the artifact **out of these indexes**: it walks `getDictIndex()` to
 * write `entries`, `words`, `gloss_fts`, `chars` and `char_words`, and it calls
 * `headwordFreq` and `headwordTotals` rather than re-implementing them, because
 * SQL `MAX(freq)` and replaying `compareEntries` disagree wherever a jieba
 * frequency is 0 or absent (data.md §6). `scripts/verify-data.ts` then proves
 * the artifact against the same parse. So the JSON dictionary is not dead — it
 * is the **input to the build**, which is exactly where it belonged all along,
 * and D6's real content is that it is no longer *also* a runtime.
 *
 * Its third consumer is `tests/unit/dict/json-oracle.ts`, which re-exports it so
 * the differential suites D2 and D3 wrote keep a live oracle instead of a
 * golden file. Read that module's header for what that does and does not prove.
 *
 * Nothing under `apps/app/lib/**` may import this file, and nothing does.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAX_WORD_CHARS } from '../apps/app/lib/dict/query/segment';
import { compareEntries, glossTokens, hasCjk, stemToken } from '../apps/app/lib/dict/rank';
import { hasUnknownReading, normalizePinyin, readingKeys } from '../apps/app/lib/dict/pinyin';
import { dataDir } from '../apps/app/lib/server/roots';
import {
  attachIds,
  planSegments,
  type SegmentResult,
  type SegmentScript,
  type SegmentStats,
} from '../apps/app/lib/dict/segment';
import type {
  DecompFile,
  DictEntry,
  DictFile,
  DictMeta,
  EntryId,
  HskBand,
} from '../apps/app/lib/dict/types';

export { glossTokens, parseIdList, stemToken } from '../apps/app/lib/dict/rank';

// ---------------------------------------------------------------------------
// The file (was lib/dict/load.ts)
// ---------------------------------------------------------------------------

export class DictDataMissingError extends Error {
  override readonly name = 'DictDataMissingError';
  readonly path: string;

  constructor(path: string, options?: { cause?: unknown }) {
    super(`dictionary data not found at ${path} — run pnpm data`, options);
    this.path = path;
  }
}

interface DictCache {
  dict?: DictFile;
  decomp?: DecompFile;
  /** Built by lib/dict/index.ts; kept here so both survive HMR together. */
  index?: unknown;
}

const CACHE_KEY = Symbol.for('tangram.dict.cache');

export function dictCache(): DictCache {
  const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: DictCache };
  return (holder[CACHE_KEY] ??= {});
}

function readJson<T>(filename: string): T {
  const path = resolve(dataDir(), filename);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new DictDataMissingError(path, { cause });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    // A truncated or half-written file is missing data as far as callers care.
    throw new DictDataMissingError(path, { cause });
  }
}

/** The parsed `data/dict.json`. Throws `DictDataMissingError` when it is not built. */
export function getDict(): DictFile {
  const cache = dictCache();
  if (!cache.dict) {
    const file = readJson<DictFile>('dict.json');
    if (!Array.isArray(file.entries) || file.entries.length === 0) {
      throw new DictDataMissingError(resolve(dataDir(), 'dict.json'));
    }
    cache.dict = file;
  }
  return cache.dict;
}

/**
 * The parsed `data/decomp.json`. Separate from the dictionary on purpose: it is
 * LGPL and must never be merged into a card snapshot.
 */
export function getDecomp(): DecompFile {
  const cache = dictCache();
  cache.decomp ??= readJson<DecompFile>('decomp.json');
  return cache.decomp;
}

/** Drop the memoised copies so a caller can change `TANGRAM_DATA_DIR`. */
export function resetDictCache(): void {
  const holder = globalThis as typeof globalThis & { [CACHE_KEY]?: DictCache };
  delete holder[CACHE_KEY];
}

// ---------------------------------------------------------------------------
// The indexes (was lib/dict/index.ts)
// ---------------------------------------------------------------------------

/** Parallel arrays sorted by `keys`, so a prefix is one binary search plus a walk. */
export interface SortedIndex {
  keys: string[];
  ids: EntryId[][];
}

export interface DictIndex {
  meta: DictMeta;
  entries: Map<EntryId, DictEntry>;
  bySimp: Map<string, EntryId[]>;
  byTrad: Map<string, EntryId[]>;
  /** `dasuan` → ids. Tones dropped, ü folded to u, spaces removed. */
  byPinyinToneless: SortedIndex;
  /** `da3suan4` → ids. */
  byPinyinToned: SortedIndex;
  /** Stemmed gloss token → ids. Variants are left out; they are not real words. */
  byGloss: Map<string, EntryId[]>;
  byHsk: Map<HskBand, EntryId[]>;
}

function push(map: Map<string, EntryId[]>, key: string, id: EntryId): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

function toSorted(groups: Map<string, EntryId[]>): SortedIndex {
  const keys = [...groups.keys()].sort();
  return { keys, ids: keys.map((key) => groups.get(key) as EntryId[]) };
}

/**
 * The indexes, each built the first time something asks for it.
 *
 * Laziness arrived for a reason that has since gone away, and it is kept for a
 * smaller one. **Then:** every dictionary route was its own serverless function
 * with its own process, each paying its own cold start, and an eager build made
 * all of them pay for all seven indexes — the band request behind the Today
 * page was building a 47,000-key English inverted index it would never read
 * (3.9 s eager per route; 1.0–2.4 s once each paid only for what it touched;
 * docs/deploy.md carries the table). **Now:** `data.md` D6 deleted those routes
 * and this file's only callers are `scripts/build-data.ts`,
 * `scripts/verify-data.ts` and the unit oracle, all of which run once in one
 * process. The laziness stays because the oracle reads two indexes out of
 * seven and building the other five would be ten seconds of every unit run.
 *
 * The getters are the whole mechanism, and they are why nothing above this file
 * changed: `index.byGloss` still reads like a field. `#ordered` is shared
 * because every other index is derived from it in the same order.
 *
 * It is memoised per process by `dictCache()`, so within one warm process this
 * is paid at most once per index.
 */
/**
 * The index is still built lazily, and that is no longer a *measured* property.
 *
 * `DICT_INDEX_PARTS` and `builtIndexParts()` existed so that
 * `tests/unit/server/cold-start.test.ts` could walk a fresh cache through one
 * route's work at a time and check that nothing else was built — laziness
 * mattered because a server paid it on every cold start. `data.md` D6 deleted
 * that suite with the routes it was about, and this module is build-side now:
 * `pnpm data` builds every part it needs in one run, and nothing measures the
 * order. The getters stay lazy because `tests/unit/dict/json-oracle.ts` reaches
 * for `bySimp` in jsdom suites that have no use for `byGloss`, and building
 * 47,125 posting lists for them would be seconds per file.
 */
class LazyDictIndex implements DictIndex {
  #ordered?: DictEntry[];
  #entries?: Map<EntryId, DictEntry>;
  #bySimp?: Map<string, EntryId[]>;
  #byTrad?: Map<string, EntryId[]>;
  #byPinyinToneless?: SortedIndex;
  #byPinyinToned?: SortedIndex;
  #byGloss?: Map<string, EntryId[]>;
  #byHsk?: Map<HskBand, EntryId[]>;

  /** Every entry in the order every index wants: frequency first. */
  get #sorted(): DictEntry[] {
    return (this.#ordered ??= [...getDict().entries].sort(compareEntries));
  }

  get meta(): DictMeta {
    return getDict().meta;
  }

  get entries(): Map<EntryId, DictEntry> {
    if (!this.#entries) {
      const entries = new Map<EntryId, DictEntry>();
      for (const entry of this.#sorted) entries.set(entry.id, entry);
      this.#entries = entries;
    }
    return this.#entries;
  }

  #buildHanzi(): void {
    const bySimp = new Map<string, EntryId[]>();
    const byTrad = new Map<string, EntryId[]>();
    for (const entry of this.#sorted) {
      push(bySimp, entry.simp, entry.id);
      push(byTrad, entry.trad, entry.id);
    }
    this.#bySimp = bySimp;
    this.#byTrad = byTrad;
  }

  get bySimp(): Map<string, EntryId[]> {
    if (!this.#bySimp) this.#buildHanzi();
    return this.#bySimp as Map<string, EntryId[]>;
  }

  get byTrad(): Map<string, EntryId[]> {
    if (!this.#byTrad) this.#buildHanzi();
    return this.#byTrad as Map<string, EntryId[]>;
  }

  #buildPinyin(): void {
    const toneless = new Map<string, EntryId[]>();
    const toned = new Map<string, EntryId[]>();
    for (const entry of this.#sorted) {
      // `xx5` is CC-CEDICT declaring it has no reading for this headword (々, ㍻).
      // Indexing it would answer a search for "xx" with 34 unrelated characters.
      if (hasUnknownReading(entry.pinyinNum)) continue;
      // The dictionary's own pinyin is already segmented, so the query parser's
      // DP is not needed for it; `readingKeys` returns null for the handful of
      // readings that are not plain numbered syllables, and those go the slow
      // way. The two agree on every reading — see `readingKeys`.
      const pinyin = readingKeys(entry.pinyinNum) ?? normalizePinyin(entry.pinyinNum);
      if (pinyin.toneless) push(toneless, pinyin.toneless, entry.id);
      if (pinyin.toned) push(toned, pinyin.toned, entry.id);
    }
    this.#byPinyinToneless = toSorted(toneless);
    this.#byPinyinToned = toSorted(toned);
  }

  get byPinyinToneless(): SortedIndex {
    if (!this.#byPinyinToneless) this.#buildPinyin();
    return this.#byPinyinToneless as SortedIndex;
  }

  get byPinyinToned(): SortedIndex {
    if (!this.#byPinyinToned) this.#buildPinyin();
    return this.#byPinyinToned as SortedIndex;
  }

  get byGloss(): Map<string, EntryId[]> {
    if (!this.#byGloss) {
      const byGloss = new Map<string, EntryId[]>();
      for (const entry of this.#sorted) {
        // Variants carry no meaning of their own ("old variant of X"); indexing
        // them under X's words would put a dead headword in front of the live one.
        if (entry.isVariant) continue;
        for (const gloss of entry.glosses) {
          for (const token of glossTokens(gloss)) push(byGloss, token, entry.id);
        }
      }
      this.#byGloss = byGloss;
    }
    return this.#byGloss;
  }

  get byHsk(): Map<HskBand, EntryId[]> {
    if (!this.#byHsk) {
      const byHsk = new Map<HskBand, EntryId[]>();
      for (const entry of this.#sorted) {
        if (entry.hskBand === undefined) continue;
        const band = byHsk.get(entry.hskBand);
        if (band) band.push(entry.id);
        else byHsk.set(entry.hskBand, [entry.id]);
      }
      // Within a band the plan orders by frequency rank; `#sorted` is already by
      // raw frequency, which is the same ordering, but sort explicitly on what
      // it promises.
      const entries = this.entries;
      for (const ids of byHsk.values()) {
        ids.sort(
          (a, b) =>
            ((entries.get(a) as DictEntry).freqRank ?? Number.MAX_SAFE_INTEGER) -
            ((entries.get(b) as DictEntry).freqRank ?? Number.MAX_SAFE_INTEGER),
        );
      }
      this.#byHsk = byHsk;
    }
    return this.#byHsk;
  }
}

/**
 * The indexes, memoised per process. Throws `DictDataMissingError` if data is
 * absent — on the first *use* of an index rather than here, since nothing is
 * read from disk until one is asked for.
 */
export function getDictIndex(): DictIndex {
  // The file is still read here rather than at the first getter, so that
  // "the dictionary has not been built" stays a `DictDataMissingError` thrown
  // where every route already catches it (a 503 with the "run pnpm data" hint)
  // instead of surfacing later, at a property access, as a 500. It is not extra
  // work: every caller of this function goes on to read an index.
  getDict();
  const cache = dictCache();
  cache.index ??= new LazyDictIndex();
  return cache.index as DictIndex;
}

/** `meta.version` of the loaded snapshot — what a card records as its `dictVersion`. */
export function dictVersion(): string {
  return getDictIndex().meta.version;
}

export function getEntry(id: EntryId): DictEntry | undefined {
  return getDictIndex().entries.get(id);
}

/**
 * How many *readings* a simplified headword has — not how many rows.
 *
 * CC-CEDICT keeps a row per traditional variant and per capitalised proper
 * noun, so 后 (后/後/Hòu), 里, 面, 出 and 云 all have several entries and one
 * reading each. `polyphone` (PLAN.md §3.4) is a claim about pronunciation: it
 * warns the learner to check *which reading* before adding, so counting rows
 * puts the warning on almost every common character and teaches them to ignore
 * it. 看 (kān/kàn) and 发 (fā/fà) are the real thing.
 */
export function readingCount(simp: string): number {
  const index = getDictIndex();
  const readings = new Set<string>();
  for (const id of index.bySimp.get(simp) ?? []) {
    const entry = index.entries.get(id);
    if (entry) readings.add(entry.pinyinNum.toLowerCase().replace(/\s+/g, ''));
  }
  return readings.size;
}

/** Entries for `ids`, in the order asked for; unknown ids are dropped. */
export function getEntries(ids: readonly EntryId[]): DictEntry[] {
  const index = getDictIndex();
  const out: DictEntry[] = [];
  for (const id of ids) {
    const entry = index.entries.get(id);
    if (entry) out.push(entry);
  }
  return out;
}

/** One HSK band, ordered by frequency rank (PLAN.md §3.2). */
export function hskBand(band: HskBand): DictEntry[] {
  const index = getDictIndex();
  return (index.byHsk.get(band) ?? []).map((id) => index.entries.get(id) as DictEntry);
}

/** First position in `keys` that is not less than `target`. */
function lowerBound(keys: readonly string[], target: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Ids under an exact key. */
export function exactIds(index: SortedIndex, key: string): EntryId[] {
  const at = lowerBound(index.keys, key);
  return index.keys[at] === key ? index.ids[at] : [];
}

/**
 * Ids under every key starting with `prefix`, in key order. `limit` caps the number
 * of ids, not keys, so a very common prefix cannot walk the whole index.
 */
export function prefixIds(index: SortedIndex, prefix: string, limit = 200): EntryId[] {
  if (!prefix) return [];
  const out: EntryId[] = [];
  for (let i = lowerBound(index.keys, prefix); i < index.keys.length; i += 1) {
    if (!index.keys[i].startsWith(prefix)) break;
    for (const id of index.ids[i]) {
      out.push(id);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Ids whose glosses contain `word` (stemmed the same way the index was built). */
export function glossIds(word: string): EntryId[] {
  return getDictIndex().byGloss.get(stemToken(word.toLowerCase())) ?? [];
}

/** `SegmentStats` per script. Keyed off the index object, so `resetDictCache()` drops it too. */
interface SegmentIndex {
  simp: SegmentStats;
  trad: SegmentStats;
}

const STATS = new WeakMap<DictIndex, SegmentIndex>();

/**
 * The frequency the DP scores a headword at, and the value `words.freq` holds in
 * the artifact. Exported because `scripts/build-data.ts` and
 * `scripts/verify-data.ts` must *call* it rather than re-implement it: SQL
 * `MAX(freq)` and replaying `compareEntries` give a different answer wherever a
 * jieba frequency is 0 or absent, and the symptom is a sentence nobody wrote a
 * segmentation case for (data.md §6).
 */
export function headwordFreq(index: DictIndex, ids: readonly EntryId[]): number {
  // Ids are stored frequency-descending, so the first one carries the word's freq.
  const first = ids.length > 0 ? index.entries.get(ids[0]) : undefined;
  return first?.freq ?? 1;
}

/**
 * The two numbers the DP needs about a script, before the log is taken:
 * the summed head frequency of every headword, and the longest headword the
 * scan will try.
 *
 * Exported for the same reason `headwordFreq` is. `scripts/build-data.ts`
 * writes both into `meta` and `scripts/verify-data.ts` checks them, and D2
 * replaces this function with a `meta` read — so all three have to agree about
 * `maxLen`'s quirk (a headword longer than `MAX_WORD_CHARS` does not raise it)
 * and about summing `headwordFreq` rather than raw `freq`. Two re-implementations
 * of a nine-line loop is how the segmenter's floor quietly shifts.
 */
export function headwordTotals(
  index: DictIndex,
  script: SegmentScript,
): { total: number; maxLen: number } {
  const map = script === 'simp' ? index.bySimp : index.byTrad;
  let total = 0;
  let maxLen = 1;
  for (const [word, ids] of map) {
    total += headwordFreq(index, ids);
    const length = [...word].length;
    if (length > maxLen && length <= MAX_WORD_CHARS) maxLen = length;
  }
  return { total, maxLen };
}

function statsFor(index: DictIndex, script: SegmentScript): SegmentStats {
  const { total, maxLen } = headwordTotals(index, script);
  return { logTotal: Math.log(total || 1), maxLen };
}

function segmentIndex(index: DictIndex): SegmentIndex {
  let cached = STATS.get(index);
  if (!cached) {
    cached = { simp: statsFor(index, 'simp'), trad: statsFor(index, 'trad') };
    STATS.set(index, cached);
  }
  return cached;
}

/**
 * Which script the text is written in. A character counts as evidence only when
 * the two scripts disagree about it — 我 and 的 are the same in both and say
 * nothing, 學 and 学 each say a great deal. Ties go to simplified, the app default.
 */
export function detectScript(index: DictIndex, text: string): SegmentScript {
  let simp = 0;
  let trad = 0;
  for (const char of text) {
    if (!hasCjk(char)) continue;
    for (const id of index.bySimp.get(char) ?? []) {
      const entry = index.entries.get(id) as DictEntry;
      if (entry.trad !== char) {
        simp += 1;
        break;
      }
    }
    for (const id of index.byTrad.get(char) ?? []) {
      const entry = index.entries.get(id) as DictEntry;
      if (entry.simp !== char) {
        trad += 1;
        break;
      }
    }
  }
  return trad > simp ? 'trad' : 'simp';
}


// ---------------------------------------------------------------------------
// Segmentation against the JSON index (was lib/dict/segment.ts)
// ---------------------------------------------------------------------------

/**
 * Segment a string against the JSON index.
 *
 * It drives the **same** DP the store does — `planSegments` and `attachIds` are
 * `lib/dict/segment.ts`'s and are shared — so the two cannot disagree about the
 * cutting, only about which candidates they were given. That is what made it a
 * useful differential oracle, and it is why it moved here rather than going: the
 * 20,000-character passage case in `tests/unit/dict/gloss.test.ts` still reads
 * it, through `json-oracle.ts`.
 */
export function segment(text: string, options: { script?: SegmentScript } = {}): SegmentResult {
  const index = getDictIndex();
  const script = options.script ?? detectScript(index, text);
  const stats = segmentIndex(index)[script];
  const primary = script === 'simp' ? index.bySimp : index.byTrad;
  const secondary = script === 'simp' ? index.byTrad : index.bySimp;
  const lookup = (word: string): EntryId[] | undefined => primary.get(word) ?? secondary.get(word);
  const freqOf = (word: string): number | undefined => {
    const ids = lookup(word);
    return ids ? headwordFreq(index, ids) : undefined;
  };
  const plan = planSegments(text, { script, stats, freqOf });
  return attachIds(plan, (word) => lookup(word) ?? []);
}
