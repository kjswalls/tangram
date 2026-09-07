/**
 * Dictionary indexes (PLAN.md §3.2), built once per process from the loaded
 * `data/dict.json` and memoised beside it on `globalThis`.
 *
 * Everything here is lookup plumbing only — routing a query to the right index and
 * ranking the results is `lib/dict/search.ts` (Phase 1). The indexes hold entry ids
 * pointing into the single parsed copy of the dictionary, never copies of entries.
 */
import { dictCache, getDict } from './load';
import { hasUnknownReading, normalizePinyin } from './pinyin';
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

/** A gloss → the stemmed tokens it is indexed under. */
export function glossTokens(gloss: string): string[] {
  const tokens = gloss
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .split(' ')
    .map((token) => stemToken(token.replace(/^'+|'+$/g, '')))
    .filter(Boolean);
  return [...new Set(tokens)];
}

function toSorted(groups: Map<string, EntryId[]>): SortedIndex {
  const keys = [...groups.keys()].sort();
  return { keys, ids: keys.map((key) => groups.get(key) as EntryId[]) };
}

function buildIndex(): DictIndex {
  const dict = getDict();
  const entries = new Map<EntryId, DictEntry>();
  const ordered = [...dict.entries].sort(compareEntries);

  const bySimp = new Map<string, EntryId[]>();
  const byTrad = new Map<string, EntryId[]>();
  const toneless = new Map<string, EntryId[]>();
  const toned = new Map<string, EntryId[]>();
  const byGloss = new Map<string, EntryId[]>();
  const byHsk = new Map<HskBand, EntryId[]>();

  for (const entry of ordered) {
    entries.set(entry.id, entry);
    push(bySimp, entry.simp, entry.id);
    push(byTrad, entry.trad, entry.id);

    // `xx5` is CC-CEDICT declaring it has no reading for this headword (々, ㍻).
    // Indexing it would answer a search for "xx" with 34 unrelated characters.
    if (!hasUnknownReading(entry.pinyinNum)) {
      const pinyin = normalizePinyin(entry.pinyinNum);
      if (pinyin.toneless) push(toneless, pinyin.toneless, entry.id);
      if (pinyin.toned) push(toned, pinyin.toned, entry.id);
    }

    // Variants carry no meaning of their own ("old variant of X"); indexing them
    // under X's words would put a dead headword in front of the live one.
    if (!entry.isVariant) {
      for (const gloss of entry.glosses) {
        for (const token of glossTokens(gloss)) push(byGloss, token, entry.id);
      }
    }

    if (entry.hskBand !== undefined) {
      const band = byHsk.get(entry.hskBand);
      if (band) band.push(entry.id);
      else byHsk.set(entry.hskBand, [entry.id]);
    }
  }

  // Within a band the plan orders by frequency rank; `ordered` is already by raw
  // frequency, which is the same ordering, but sort explicitly on what it promises.
  for (const ids of byHsk.values()) {
    ids.sort(
      (a, b) =>
        ((entries.get(a) as DictEntry).freqRank ?? Number.MAX_SAFE_INTEGER) -
        ((entries.get(b) as DictEntry).freqRank ?? Number.MAX_SAFE_INTEGER),
    );
  }

  return {
    meta: dict.meta,
    entries,
    bySimp,
    byTrad,
    byPinyinToneless: toSorted(toneless),
    byPinyinToned: toSorted(toned),
    byGloss,
    byHsk,
  };
}

/** The indexes, built on first use. Throws `DictDataMissingError` if data is absent. */
export function getDictIndex(): DictIndex {
  const cache = dictCache();
  cache.index ??= buildIndex();
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
