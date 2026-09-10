/**
 * Dictionary indexes (PLAN.md §3.2), built once per process from the loaded
 * `data/dict.json` and memoised beside it on `globalThis`.
 *
 * Everything here is lookup plumbing only — routing a query to the right index and
 * ranking the results is `lib/dict/search.ts` (Phase 1). The indexes hold entry ids
 * pointing into the single parsed copy of the dictionary, never copies of entries.
 */
import { drain, SLICE, sortInSlices, toSortedInSlices } from './incremental';
import { dictCache, getDict } from './load';
import { hasUnknownReading, normalizePinyin, readingKeys } from './pinyin';
import type { DictEntry, DictMeta, EntryId, HskBand } from './types';

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

/**
 * Frequency first — that is the order every list in the UI wants. Entries of one
 * headword share a jieba frequency, so the tiebreaks decide between readings:
 * ordinary words before proper nouns before variants, then the id for determinism.
 */
function compareEntries(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    (a.id < b.id ? -1 : 1)
  );
}

function push(map: Map<string, EntryId[]>, key: string, id: EntryId): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/** Trivial English stemming, applied identically at build and query time. */
export function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** `a-z`, `0-9` or an apostrophe — the alphabet a gloss token is made of. */
function isTokenChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 39;
}

/**
 * A gloss → the stemmed tokens it is indexed under, deduped, in order.
 *
 * One scan over the lowercased string rather than replace-split-map-filter.
 * It is called 195,550 times while the gloss index is built and again on every
 * English query, and the four intermediate arrays were most of its cost.
 * `tests/unit/server/cold-start.test.ts` checks the two agree on every gloss in the
 * built dictionary, so this is a faster spelling of the same function and not a
 * different one.
 */
export function glossTokens(gloss: string): string[] {
  const lower = gloss.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const length = lower.length;
  let i = 0;
  while (i < length) {
    if (!isTokenChar(lower.charCodeAt(i))) {
      i += 1;
      continue;
    }
    let start = i;
    while (i < length && isTokenChar(lower.charCodeAt(i))) i += 1;
    let end = i;
    // A leading or trailing apostrophe is punctuation, not part of the word.
    while (start < end && lower.charCodeAt(start) === 39) start += 1;
    while (end > start && lower.charCodeAt(end - 1) === 39) end -= 1;
    if (end <= start) continue;
    const token = stemToken(lower.slice(start, end));
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * The indexes, each built the first time something asks for it.
 *
 * Laziness is here so that a request pays only for the indexes it reads. It is
 * **not** about one process per route: Vercel groups route handlers whose config
 * matches into a single function (verified with `vercel build` — see
 * docs/deploy.md §5), so all eight of this app's routes share one process and one
 * set of indexes. What laziness buys inside that shared process is still real, and
 * it is the *first* request of each kind that collects: `/api/dict/hsk` — the very
 * first request the app makes, behind the Today page — does not build the
 * 47,000-key English inverted index it will never read. Measured on the build box:
 * 3.9 s eager for the first request whatever it was; 1.0 s for `hsk` and
 * `entries`, 1.3 s for `segment`, 2.1 s for `search`, now that each pays only for
 * what it touches.
 *
 * Since Phase 9 the bill mostly arrives earlier still and unattended — the banner's
 * probe schedules `lib/dict/warm.ts`, which builds everything in slices — so
 * laziness is what keeps *that* work off the probe's own response, not what decides
 * whether a lookup waits.
 *
 * The getters are the whole mechanism, and they are why nothing above this file
 * changed: `index.byGloss` still reads like a field. `#ordered` is shared
 * because every other index is derived from it in the same order. Each getter
 * drives the same slice-wise builder the warm-up drives (`drain`), so there is one
 * implementation per index and no eager/incremental pair to keep in step.
 *
 * It is memoised per process by `dictCache()`, so within one warm process this
 * is paid at most once per index.
 */
export const DICT_INDEX_PARTS = ['sorted', 'entries', 'hanzi', 'pinyin', 'gloss', 'hsk'] as const;

/** One lazily-built piece of `DictIndex`. See `builtIndexParts()`. */
export type DictIndexPart = (typeof DICT_INDEX_PARTS)[number];

class LazyDictIndex implements DictIndex {
  #ordered?: DictEntry[];
  #entries?: Map<EntryId, DictEntry>;
  #bySimp?: Map<string, EntryId[]>;
  #byTrad?: Map<string, EntryId[]>;
  #byPinyinToneless?: SortedIndex;
  #byPinyinToned?: SortedIndex;
  #byGloss?: Map<string, EntryId[]>;
  #byHsk?: Map<HskBand, EntryId[]>;

  /**
   * Which parts have actually been built, in `DICT_INDEX_PARTS` order.
   *
   * Diagnostics, and the only way laziness can be *tested* rather than
   * asserted: `tests/unit/server/cold-start.test.ts` walks a fresh cache
   * through one route's work at a time and checks that nothing else was built.
   * A property nobody can observe is a property that quietly stops holding.
   */
  builtParts(): DictIndexPart[] {
    return [
      ...(this.#ordered ? (['sorted'] as const) : []),
      ...(this.#entries ? (['entries'] as const) : []),
      ...(this.#bySimp ? (['hanzi'] as const) : []),
      ...(this.#byPinyinToneless ? (['pinyin'] as const) : []),
      ...(this.#byGloss ? (['gloss'] as const) : []),
      ...(this.#byHsk ? (['hsk'] as const) : []),
    ];
  }

  /**
   * Build one part in bounded steps — the shared implementation behind both the
   * getters below and `lib/dict/warm.ts`. Already-built parts are a no-op, so a
   * warm-up can drive every part without checking first.
   *
   * `sorted` is the one step that cannot be bounded further than it already is:
   * it is `JSON.parse` (in `getDict()`) plus one 120k-element sort. The parse is
   * atomic, and the sort is sliced like the rest.
   */
  *buildInSlices(part: DictIndexPart): Generator<void> {
    switch (part) {
      case 'sorted':
        yield* this.#sortedSteps();
        return;
      case 'entries':
        if (!this.#entries) yield* this.#entriesSteps();
        return;
      case 'hanzi':
        if (!this.#bySimp) yield* this.#hanziSteps();
        return;
      case 'pinyin':
        if (!this.#byPinyinToneless) yield* this.#pinyinSteps();
        return;
      case 'gloss':
        if (!this.#byGloss) yield* this.#glossSteps();
        return;
      case 'hsk':
        if (!this.#byHsk) yield* this.#hskSteps();
        return;
    }
  }

  *#sortedSteps(): Generator<void> {
    if (this.#ordered) return;
    const ordered = [...getDict().entries];
    yield* sortInSlices(ordered, compareEntries);
    this.#ordered = ordered;
  }

  /**
   * Every entry in the order every index wants: frequency first.
   *
   * The eager spelling of `#sortedSteps`, for the getters — a direct caller is
   * already waiting, so slicing it would only add turns.
   */
  get #sorted(): DictEntry[] {
    if (!this.#ordered) drain(this.#sortedSteps());
    return this.#ordered as DictEntry[];
  }

  get meta(): DictMeta {
    return getDict().meta;
  }

  *#entriesSteps(): Generator<void> {
    const sorted = this.#sorted;
    const entries = new Map<EntryId, DictEntry>();
    for (let i = 0; i < sorted.length; i += 1) {
      entries.set(sorted[i].id, sorted[i]);
      if ((i + 1) % SLICE === 0) yield;
    }
    this.#entries = entries;
  }

  get entries(): Map<EntryId, DictEntry> {
    if (!this.#entries) drain(this.#entriesSteps());
    return this.#entries as Map<EntryId, DictEntry>;
  }

  *#hanziSteps(): Generator<void> {
    const sorted = this.#sorted;
    const bySimp = new Map<string, EntryId[]>();
    const byTrad = new Map<string, EntryId[]>();
    for (let i = 0; i < sorted.length; i += 1) {
      const entry = sorted[i];
      push(bySimp, entry.simp, entry.id);
      push(byTrad, entry.trad, entry.id);
      if ((i + 1) % SLICE === 0) yield;
    }
    // Published together and only at the end: a half-filled map handed to a
    // request that arrives mid-slice would be wrong answers, not slow ones.
    this.#bySimp = bySimp;
    this.#byTrad = byTrad;
  }

  get bySimp(): Map<string, EntryId[]> {
    if (!this.#bySimp) drain(this.#hanziSteps());
    return this.#bySimp as Map<string, EntryId[]>;
  }

  get byTrad(): Map<string, EntryId[]> {
    if (!this.#byTrad) drain(this.#hanziSteps());
    return this.#byTrad as Map<string, EntryId[]>;
  }

  *#pinyinSteps(): Generator<void> {
    const sorted = this.#sorted;
    const toneless = new Map<string, EntryId[]>();
    const toned = new Map<string, EntryId[]>();
    for (let i = 0; i < sorted.length; i += 1) {
      const entry = sorted[i];
      if ((i + 1) % SLICE === 0) yield;
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
    const sortedToneless = yield* toSortedInSlices(toneless);
    const sortedToned = yield* toSortedInSlices(toned);
    this.#byPinyinToneless = sortedToneless;
    this.#byPinyinToned = sortedToned;
  }

  get byPinyinToneless(): SortedIndex {
    if (!this.#byPinyinToneless) drain(this.#pinyinSteps());
    return this.#byPinyinToneless as SortedIndex;
  }

  get byPinyinToned(): SortedIndex {
    if (!this.#byPinyinToned) drain(this.#pinyinSteps());
    return this.#byPinyinToned as SortedIndex;
  }

  *#glossSteps(): Generator<void> {
    const sorted = this.#sorted;
    const byGloss = new Map<string, EntryId[]>();
    for (let i = 0; i < sorted.length; i += 1) {
      const entry = sorted[i];
      if ((i + 1) % SLICE === 0) yield;
      // Variants carry no meaning of their own ("old variant of X"); indexing
      // them under X's words would put a dead headword in front of the live one.
      if (entry.isVariant) continue;
      for (const gloss of entry.glosses) {
        for (const token of glossTokens(gloss)) push(byGloss, token, entry.id);
      }
    }
    this.#byGloss = byGloss;
  }

  get byGloss(): Map<string, EntryId[]> {
    if (!this.#byGloss) drain(this.#glossSteps());
    return this.#byGloss as Map<string, EntryId[]>;
  }

  *#hskSteps(): Generator<void> {
    const sorted = this.#sorted;
    const byHsk = new Map<HskBand, EntryId[]>();
    for (let i = 0; i < sorted.length; i += 1) {
      const entry = sorted[i];
      if ((i + 1) % SLICE === 0) yield;
      if (entry.hskBand === undefined) continue;
      const band = byHsk.get(entry.hskBand);
      if (band) band.push(entry.id);
      else byHsk.set(entry.hskBand, [entry.id]);
    }
    // Within a band the plan orders by frequency rank; `#sorted` is already by
    // raw frequency, which is the same ordering, but sort explicitly on what
    // it promises. A band is a few thousand ids, so these sorts are steps in
    // their own right without being sliced further.
    const entries = this.entries;
    for (const ids of byHsk.values()) {
      ids.sort(
        (a, b) =>
          ((entries.get(a) as DictEntry).freqRank ?? Number.MAX_SAFE_INTEGER) -
          ((entries.get(b) as DictEntry).freqRank ?? Number.MAX_SAFE_INTEGER),
      );
      yield;
    }
    this.#byHsk = byHsk;
  }

  get byHsk(): Map<HskBand, EntryId[]> {
    if (!this.#byHsk) drain(this.#hskSteps());
    return this.#byHsk as Map<HskBand, EntryId[]>;
  }
}

/**
 * Build one index part in bounded steps: `next()` does a slice, the caller decides
 * whether to hand the event loop back between them. `lib/dict/warm.ts` is the
 * caller that does; every getter above drives the same generators to completion.
 *
 * It reads the cache the way `builtIndexParts()` does rather than taking a
 * `DictIndex`, so there is no second way for a caller to name the index and no
 * unreachable branch for an index this module did not build.
 */
export function* buildPartInSlices(part: DictIndexPart): Generator<void> {
  const index = dictCache().index;
  if (index instanceof LazyDictIndex) yield* index.buildInSlices(part);
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

/**
 * Which index parts this process has built so far — `[]` before anything has
 * asked for one. Diagnostic only; nothing in the app branches on it.
 */
export function builtIndexParts(): DictIndexPart[] {
  const cached = dictCache().index;
  return cached instanceof LazyDictIndex ? cached.builtParts() : [];
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

/**
 * Split a comma-separated id list, e.g. from `?ids=`. An id is `trad|simp[pinyin]`
 * and the pinyin of a proverb contains commas (`yi1 bu4 zuo4 , er4 bu4 xiu1`), so
 * only commas outside the brackets separate ids.
 */
export function parseIdList(value: string): EntryId[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((id) => id.trim()).filter(Boolean);
}

/** Ids whose glosses contain `word` (stemmed the same way the index was built). */
export function glossIds(word: string): EntryId[] {
  return getDictIndex().byGloss.get(stemToken(word.toLowerCase())) ?? [];
}
