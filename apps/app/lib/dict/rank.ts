/**
 * Ordering and ranking helpers, kept apart from the index that used to hold them
 * (docs/plans/data.md D1, D2).
 *
 * `compareEntries` lives here because it is now a property of the *artifact*:
 * `scripts/build-data.ts` assigns `entries.rowid` in exactly this order and
 * `scripts/verify-data.ts` re-checks it, so `ORDER BY rowid` reproduces every
 * frequency-ordered list the app has without a four-clause sort. It was private
 * to `lib/dict/index.ts`; `index.ts` imports it back, so nothing else changed.
 *
 * Pure and dependency-free, like `lib/dict/pinyin.ts` — it runs in the build
 * script, in Node and in the browser.
 */
import type { DictEntry } from './types';

/**
 * Frequency first — that is the order every list in the UI wants. Entries of one
 * headword share a jieba frequency, so the tiebreaks decide between readings:
 * ordinary words before proper nouns before variants, then the id for determinism.
 */
export function compareEntries(a: DictEntry, b: DictEntry): number {
  return (
    (b.freq ?? -1) - (a.freq ?? -1) ||
    Number(a.isVariant) - Number(b.isVariant) ||
    Number(a.properNoun) - Number(b.properNoun) ||
    (a.id < b.id ? -1 : 1)
  );
}
