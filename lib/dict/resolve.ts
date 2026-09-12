/**
 * Bulk headword resolution for the list importer (PLAN.md §3.3, lists).
 *
 * One word in, every dictionary entry it could mean out — never a ranking
 * across headwords, which is `search.ts`'s job. The rule is the importer's:
 *
 *   1. anything with a hanzi in it is matched **exactly** against both scripts
 *      (`bySimp` and `byTrad`), so a simplified list and a traditional one
 *      resolve alike and a prefix never counts (`打` must not become 打算);
 *   2. otherwise, if it parses as pinyin, tone-exact first and toneless as the
 *      fallback (`nǐhǎo`, `ni3hao3` and `nihao` all find 你好; `le` finds every
 *      headword read `le`, and the importer's picker sorts out which);
 *   3. otherwise nothing — English is not a way to name a word for a list.
 *
 * Entries come back in the index's frequency order (`compareEntries` in
 * `index.ts`), so the first one is the reading a picker should default to.
 * Everything here reads the indexes; nothing re-reads `data/dict.json`.
 */
import { exactIds, getDictIndex, type DictIndex } from './index';
import { normalizePinyin } from './pinyin';
import { hasCjk } from './search';
import type { DictEntry, EntryId } from './types';

/** Which rule matched. `none` means the word is not in the dictionary. */
export type ResolveVia = 'hanzi' | 'pinyin' | 'none';

export interface ResolvedWord {
  /** The word as asked, trimmed. */
  word: string;
  via: ResolveVia;
  /** Every candidate, most frequent first; empty when `via` is `none`. */
  entries: DictEntry[];
}

export interface ResolveResult {
  /** `meta.version` of the snapshot the entries came from. */
  dictVersion: string;
  /** One per word asked, in the order asked. */
  results: ResolvedWord[];
}

/** The most words one request resolves; a Pleco export is chunked to fit. */
export const RESOLVE_MAX_WORDS = 1000;
/** Nothing longer is one word. Mirrors the search route's query cap. */
export const RESOLVE_MAX_WORD_CHARS = 200;

/**
 * The index's own order: frequency first, then real words before variants
 * before proper nouns, then the id. Restated here because the hanzi path joins
 * two index lists (both scripts) and the join has to be put back in that order.
 */
function compareEntries(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    (a.id < b.id ? -1 : 1)
  );
}

function entriesFor(index: DictIndex, ids: readonly EntryId[]): DictEntry[] {
  const seen = new Set<EntryId>();
  const out: DictEntry[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = index.entries.get(id);
    if (entry) out.push(entry);
  }
  return out;
}

/** Resolve one word against a given index. */
export function resolveWord(index: DictIndex, input: string): ResolvedWord {
  const word = input.trim();
  if (!word) return { word, via: 'none', entries: [] };

  if (hasCjk(word)) {
    const entries = entriesFor(index, [
      ...(index.bySimp.get(word) ?? []),
      ...(index.byTrad.get(word) ?? []),
    ]).sort(compareEntries);
    return { word, via: entries.length > 0 ? 'hanzi' : 'none', entries };
  }

  const pinyin = normalizePinyin(word);
  if (!pinyin.fullyParsed) return { word, via: 'none', entries: [] };
  const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
  let ids: EntryId[] = toned ? exactIds(index.byPinyinToned, pinyin.toned) : [];
  if (ids.length === 0) ids = exactIds(index.byPinyinToneless, pinyin.toneless);
  const entries = entriesFor(index, ids);
  return { word, via: entries.length > 0 ? 'pinyin' : 'none', entries };
}

/** Resolve every word, in order. Throws `DictDataMissingError` when there is no data. */
export function resolveWords(words: readonly string[]): ResolveResult {
  const index = getDictIndex();
  return {
    dictVersion: index.meta.version,
    results: words.map((word) => resolveWord(index, word)),
  };
}
