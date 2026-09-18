/**
 * The lists layer's one seam to the dictionary, after the Phase 1–3 merge.
 *
 * Two things are being pinned here, both cross-phase: "add a word to this list"
 * asks P1's router through `DictStore.search` (so the list box and the lookup
 * box rank a query the same way, and the band scan is only the fallback), and
 * every entry-bearing answer names its snapshot so a card made from it can
 * record a real `dictVersion` instead of `'unknown'`.
 *
 * **Driven through a fake `DictStore` since `data.md` D6.** It used to stub
 * `fetch` and assert on the URLs, because `lib/dict/http-store.ts` was a
 * `DictStore` over the five dictionary routes. They are gone and the browser's store
 * is `sqlite-wasm` on OPFS, so a `fetch` stub would assert nothing at all — it
 * would be a suite that could not fail. The fake below implements the frozen
 * interface, and every expected value in this file is unchanged; what moved is
 * that the calls are counted on the interface rather than on a URL, which is the
 * thing `lib/lists/entry-source.ts` actually depends on.
 */
import { describe, expect, it } from 'vitest';

import { createHttpEntrySource } from '@/lib/lists/entry-source';
import type { SearchOptions, SearchResult } from '@/lib/dict/search';
import type { DictStatus, DictStore } from '@/lib/dict/store';
import type { Entry, HskBand } from '@/lib/types';

const VERSION = '1.3.20251213';

function entry(simp: string, pinyinNum: string, gloss: string): Entry {
  return {
    id: `${simp}|${simp}[${pinyinNum}]`,
    simp,
    trad: simp,
    pinyinNum,
    pinyinMarked: simp,
    glosses: [gloss],
    classifiers: [],
    properNoun: false,
    isVariant: false,
    surname: false,
  };
}

const LE = entry('了', 'le5', 'completed action marker');
const LIAO = entry('了', 'liao3', 'to finish');
const DASUAN = entry('打算', 'da3 suan4', 'to plan');

/** P1's `SearchResult`: groups by headword, every reading inside one group. */
function searchBody(): SearchResult {
  return {
    query: '了',
    route: 'hanzi',
    dictVersion: VERSION,
    total: 2,
    offset: 0,
    groups: [
      { key: '了|了', simp: '了', trad: '了', source: 'hanzi', matchedIds: [LE.id], entries: [LE, LIAO] },
      {
        key: '打算|打算',
        simp: '打算',
        trad: '打算',
        source: 'hanzi',
        matchedIds: [DASUAN.id],
        entries: [DASUAN],
      },
    ],
    sections: [],
  };
}

interface Calls {
  search: string[];
  bands: HskBand[];
  entries: number;
}

/**
 * A `DictStore` that answers what a case tells it to, and records what it was
 * asked. `status` is `ready` with the snapshot, because that is where the
 * version comes from now — `SearchResult.dictVersion` carries it too, and
 * `entries()`/`hskBand()` do not carry one at all.
 */
function fakeStore(
  answers: {
    search?: (query: string, options: SearchOptions) => Promise<SearchResult>;
    hskBand?: (band: HskBand) => Entry[];
    entries?: Entry[];
    status?: DictStatus;
  } = {},
): { store: DictStore; calls: Calls } {
  const calls: Calls = { search: [], bands: [], entries: 0 };
  const store: DictStore = {
    status: answers.status ?? { state: 'ready', version: VERSION },
    subscribe: () => () => {},
    open: async () => {},
    async search(query, options = {}) {
      calls.search.push(query);
      if (!answers.search) throw new Error('the dictionary cannot answer');
      return answers.search(query, options);
    },
    async segment(text) {
      return { text, script: 'simp', tokens: [] };
    },
    async entries(ids) {
      calls.entries += 1;
      const pool = answers.entries ?? [];
      return ids.flatMap((id) => pool.filter((row) => row.id === id));
    },
    async hskBand(band) {
      calls.bands.push(band);
      return answers.hskBand?.(band) ?? [];
    },
    async readingCount() {
      return 0;
    },
    async wordsContaining() {
      return [];
    },
  };
  return { store, calls };
}

describe('EntrySource.search', () => {
  it('asks the store and flattens its groups, readings and all', async () => {
    const { store, calls } = fakeStore({ search: async () => searchBody() });

    const source = createHttpEntrySource({ store });
    const results = await source.search('了', 10);

    expect(calls.search).toEqual(['了']);
    // A polyphone is one group carrying both readings; a list holds entries, so
    // both readings are offered — and in P1's order, matched reading first.
    expect(results.map((row) => row.id)).toEqual([LE.id, LIAO.id, DASUAN.id]);
    // The snapshot travelled with the answer, so a card made from it can say so.
    expect(source.dictVersion?.()).toBe(VERSION);
    // …and the band fallback never ran.
    expect(calls.bands).toEqual([]);
  });

  it('honours the limit and treats an empty answer as an answer', async () => {
    const { store, calls } = fakeStore({
      search: async () => ({ ...searchBody(), groups: [], total: 0 }),
    });
    const source = createHttpEntrySource({ store });
    expect(await source.search('nothingatall', 10)).toEqual([]);
    expect(calls.bands).toEqual([]);
  });

  it('passes the limit through to the store', async () => {
    let seen: SearchOptions | undefined;
    const { store } = fakeStore({
      search: async (_query, options) => {
        seen = options;
        return searchBody();
      },
    });
    await createHttpEntrySource({ store }).search('了', 3);
    expect(seen?.limit).toBe(3);
  });

  it('falls back to scanning the HSK bands when the store cannot answer', async () => {
    // What "cannot answer" means changed with the store: it was a 503
    // `dict-data-missing` from the route, and it is a rejected promise from a
    // dictionary that is absent, still importing, or evicted mid-session.
    const { store, calls } = fakeStore({
      hskBand: (band) => (band === 1 ? [DASUAN] : []),
      status: { state: 'failed', reason: 'download', message: 'no dictionary' },
    });

    const source = createHttpEntrySource({ store });
    const results = await source.search('to plan', 10);

    expect(calls.search).toEqual(['to plan']);
    expect(calls.bands).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(results.map((row) => row.id)).toEqual([DASUAN.id]);
  });
});

describe('EntrySource.dictVersion', () => {
  it('is learned from a batch of entries', async () => {
    const { store } = fakeStore({ entries: [DASUAN] });
    const source = createHttpEntrySource({ store });
    expect(source.dictVersion?.()).toBeUndefined();
    await source.entries([DASUAN.id]);
    expect(source.dictVersion?.()).toBe(VERSION);
  });

  it('is learned from an HSK band', async () => {
    const { store } = fakeStore({ hskBand: () => [DASUAN] });
    const source = createHttpEntrySource({ store });
    await source.band(1);
    expect(source.dictVersion?.()).toBe(VERSION);
  });

  it('stays undefined while the dictionary is not ready', async () => {
    // The point of reading it off `status` rather than off a response body: a
    // card stamped from a store that cannot say which snapshot it is answering
    // from falls back to the repository's `'unknown'` rather than to a stale
    // string.
    const { store } = fakeStore({ hskBand: () => [DASUAN], status: { state: 'preparing' } });
    const source = createHttpEntrySource({ store });
    await source.band(1);
    expect(source.dictVersion?.()).toBeUndefined();
  });
});
