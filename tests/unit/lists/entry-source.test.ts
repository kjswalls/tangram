/**
 * The lists layer's one seam to the dictionary, after the Phase 1–3 merge.
 *
 * Two things are being pinned here, both cross-phase: "add a word to this list"
 * asks P1's `/api/dict/search` (so the list box and the lookup box rank a query
 * the same way, and the band scan is only the offline fallback), and every
 * entry-bearing response names its snapshot so a card made from it can record a
 * real `dictVersion` instead of `'unknown'`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpEntrySource } from '@/lib/lists/entry-source';
import type { Entry } from '@/lib/types';

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
function searchBody() {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EntrySource.search', () => {
  it('asks /api/dict/search and flattens its groups, readings and all', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(json(searchBody()));
    });

    const source = createHttpEntrySource();
    const results = await source.search('了', 10);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/dict/search?q=');
    // A polyphone is one group carrying both readings; a list holds entries, so
    // both readings are offered — and in P1's order, matched reading first.
    expect(results.map((row) => row.id)).toEqual([LE.id, LIAO.id, DASUAN.id]);
    // The snapshot travelled with the answer, so a card made from it can say so.
    expect(source.dictVersion?.()).toBe(VERSION);
  });

  it('honours the limit and treats an empty answer as an answer', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json({ ...searchBody(), groups: [] })));
    const source = createHttpEntrySource();
    expect(await source.search('nothingatall', 10)).toEqual([]);
  });

  it('falls back to scanning the HSK bands when the route cannot answer', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes('/api/dict/search')) {
        return Promise.resolve(json({ error: 'dict-data-missing', hint: 'run pnpm data' }, 503));
      }
      const band = Number(new URL(url, 'http://localhost').searchParams.get('band'));
      return Promise.resolve(
        json({ meta: { version: VERSION }, band, entries: band === 1 ? [DASUAN] : [] }),
      );
    });

    const source = createHttpEntrySource();
    const results = await source.search('to plan', 10);

    expect(paths[0]).toContain('/api/dict/search');
    expect(paths.slice(1).every((path) => path.includes('/api/dict/hsk'))).toBe(true);
    expect(results.map((row) => row.id)).toEqual([DASUAN.id]);
  });
});

describe('EntrySource.dictVersion', () => {
  it('is learned from the entries route too', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ meta: { version: VERSION }, entries: [DASUAN] })),
    );
    const source = createHttpEntrySource();
    expect(source.dictVersion?.()).toBeUndefined();
    await source.entries([DASUAN.id]);
    expect(source.dictVersion?.()).toBe(VERSION);
  });

  it('is learned from an HSK band', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ meta: { version: VERSION }, band: 1, entries: [DASUAN] })),
    );
    const source = createHttpEntrySource();
    await source.band(1);
    expect(source.dictVersion?.()).toBe(VERSION);
  });
});
