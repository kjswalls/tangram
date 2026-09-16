// @vitest-environment node
/**
 * Are the golden fixtures still describing the dictionary on disk?
 *
 * `data.md` D6 froze what the JSON implementation answered, immediately before
 * deleting it, because D2's and D3's differential tests would otherwise pass for
 * the worst possible reason — nothing left to disagree with. A frozen answer has
 * one failure mode a live oracle does not: the **data** can move under it.
 *
 * So this is its own file and its own failure. Without it, an upstream change to
 * the HSK list or the jieba frequency table reports as thirty unrelated
 * assertion failures across `store.test.ts` and `gloss.test.ts` and nobody reads
 * them as one cause.
 */
import { describe, expect, it } from 'vitest';

import { goldenRetrieve, goldenSearch, dictEntriesSha256, STALE_HINT } from './golden';
import { getDict } from './json-oracle';
import { requireDictData } from './data-required';

requireDictData();

describe('the golden fixtures', () => {
  it('were cut from the dictionary entries that are on disk now', () => {
    // The digest is over `dict.json`'s entries, not over the file: the file
    // carries `meta.builtAt`, so a whole-file hash would report every rebuild as
    // a data change and this alarm would be noise within a day.
    expect(goldenSearch.provenance.dictEntriesSha256, STALE_HINT).toBe(dictEntriesSha256());
  });

  it('carry the same provenance in both files', () => {
    // They were written by one run of one generator; two stamps that disagree
    // mean one of them was regenerated on its own, which is exactly the state
    // where `retrieve.test.ts` and `store.test.ts` would be comparing the store
    // against two different dictionaries.
    expect(goldenRetrieve.provenance).toEqual(goldenSearch.provenance);
  });

  it('agree with the dictionary about its version and its size', () => {
    const dict = getDict();
    expect(goldenSearch.provenance.dictVersion).toBe(dict.meta.version);
    expect(goldenSearch.provenance.entryCount).toBe(dict.entries.length);
  });

  it('are not empty in any of the six things they freeze', () => {
    // A generator that wrote `{}` for a section would otherwise make every
    // assertion over that section vacuously true.
    expect(goldenSearch.corpus.length).toBeGreaterThanOrEqual(200);
    expect(Object.keys(goldenSearch.hanzi).length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(goldenSearch.pinyin).length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(goldenSearch.gloss).length).toBe(goldenSearch.corpus.length);
    expect(Object.keys(goldenSearch.routing).length).toBe(6);
    expect(Object.keys(goldenSearch.paging)).toEqual(['da', 'to']);
    expect(goldenSearch.longPassage.tokenCount).toBeGreaterThan(5_000);
    expect(Object.keys(goldenRetrieve.mergedSearch).length).toBeGreaterThanOrEqual(20);
    expect(goldenRetrieve.candidateEntries.length).toBeGreaterThanOrEqual(8);
    // …and the two paging walks actually walked.
    for (const [query, walk] of Object.entries(goldenSearch.paging)) {
      expect(walk.keys.length, query).toBe(walk.total);
      expect(walk.pages, query).toBeGreaterThan(1);
    }
  });
});
