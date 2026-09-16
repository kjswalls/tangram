/**
 * The JSON dictionary, as the test suites' oracle (docs/plans/data.md D6).
 *
 * D2's and D3's strongest tests are **differential**: they ask whether the
 * SQLite store answers what the JSON index answers, in one process, over the
 * same data. D6 deletes the JSON index *from the application*, and its
 * instruction is to freeze those comparisons into golden fixtures before the
 * first deletion. `golden/` is that freeze, and it covers the answers the
 * deleted **algorithms** decided — `search()`'s router and group ordering, and
 * `app/api/ask/route.ts`'s retrieval.
 *
 * This module covers the rest, and it is not a fixture, because it does not have
 * to be. The JSON dictionary did not stop existing: `scripts/build-data.ts`
 * **builds the artifact out of it**, so it survives at `scripts/dict-json.ts` as
 * the build's input, and `pnpm data:verify` already proves the artifact against
 * it. A live oracle beats a frozen one wherever one is available — `pnpm data`
 * pulls the HSK list and the jieba frequencies from `master` branches, so a
 * fixture of 11,028 ids goes stale on the first upstream change and can then
 * only be re-blessed by hand.
 *
 * **What this does and does not prove.** The store is answering from
 * `dict-<schema>-<cedict>.sqlite`, whose tables and indexes were written by
 * `build-data.ts` in SQL; the oracle is the JSON parse plus the six index loops.
 * A disagreement means the build step, the schema or a query is wrong, which is
 * the class of bug D2's criteria were written for. What it cannot catch is
 * `lib/dict/rank.ts` being wrong — but nothing ever could, because `rank.ts` is
 * **shared** by both sides; `store.test.ts` says so where it checks a group's
 * HSK band against the raw JSON instead.
 *
 * It reaches out of `apps/app` into `scripts/`, which is deliberate and has
 * precedent (`tests/unit/ui/tokens.test.ts` imports `scripts/fonts.ts`,
 * `tests/unit/pwa/manifest.test.ts` reads `scripts/sw.template.js`). One
 * implementation of the JSON index, in the one place that still needs it.
 */
import {
  detectScript,
  getDict,
  getDictIndex,
  getDecomp,
  getEntries,
  getEntry,
  glossIds,
  headwordFreq,
  headwordTotals,
  hskBand,
  readingCount,
  resetDictCache,
  segment,
  exactIds,
  prefixIds,
  type DictIndex,
  type SortedIndex,
} from '../../../../../scripts/dict-json';
import type { DictEntry, EntryId } from '@/lib/dict/types';

export { glossTokens, parseIdList, stemToken } from '@/lib/dict/rank';

export {
  detectScript,
  getDict,
  getDictIndex,
  getDecomp,
  getEntries,
  getEntry,
  glossIds,
  headwordFreq,
  headwordTotals,
  hskBand,
  readingCount,
  resetDictCache,
  segment,
  exactIds,
  prefixIds,
};
export type { DictIndex, SortedIndex };

/** `bySimp`/`byTrad` as the sorted shape `prefixIds` wants. */
export function sortedHeadwords(map: Map<string, EntryId[]>): SortedIndex {
  const keys = [...map.keys()].sort();
  return { keys, ids: keys.map((key) => map.get(key) as EntryId[]) };
}

/** Every reading of a simplified headword, in the dictionary's own order. */
export function entriesBySimp(word: string): DictEntry[] {
  return getEntries(getDictIndex().bySimp.get(word) ?? []);
}

/**
 * Every entry in rowid order — `compareEntries` order, which is the order
 * `build-data.ts` inserted them in and therefore the artifact's `rowid` order.
 */
export function orderedEntries(): DictEntry[] {
  return [...getDictIndex().entries.values()];
}
