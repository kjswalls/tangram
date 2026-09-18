// @vitest-environment node
/**
 * The support pool — the learner's known words as dictionary rows.
 *
 * **These assertions came from `tests/unit/ai/examples-route.test.ts`.** Until
 * `backend.md` B2 the pool was assembled on the server, because the server held
 * the dictionary; after the contract flip the client resolves it and sends it,
 * so the function moved to `lib/srs/known-set.ts` and its tests moved with it.
 * Every expected value below is unchanged, which is the point: the rules about
 * what counts as a known word did not change, only where they run.
 *
 * It runs against the real 124k-entry dictionary, for the reason the route's
 * version did: "a headword is not a word" is a claim about Chinese, and a
 * fixture dictionary is a fixture that can agree with a bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { offeredSupport, supportEntries, type SupportPool } from '@/lib/srs/known-set';
import { SUPPORT_CAP } from '@tangram/ai/schemas';
import { closeServerDictStore, serverDictStore } from '@/lib/server/dict';
import type { DictStore } from '@/lib/dict/store';
import { HSK_BANDS, type Entry, type HskBand } from '@/lib/types';
import { requireDictData } from '../dict/data-required';
import { entriesFor, entryFor, readingOf } from '../ai/helpers';

beforeAll(requireDictData);

let store: DictStore;
beforeAll(async () => {
  store = await serverDictStore();
});
afterAll(closeServerDictStore);

/** HSK 1–2 words, the way a demo learner's known set arrives. */
const KNOWN = ['我', '是', '的', '很', '好', '你', '天', '看', '书', '学习'];

/**
 * The same learner as entry ids — which is what the filter is built from. A
 * headword is not a word: 看 alone is `看|看[kan4]` "to see" and
 * `看|看[kan1]` "to look after", and knowing one of them says nothing about
 * the other.
 */
const knownIds = (): string[] => KNOWN.map((word) => entriesFor(word)[0]!.id);

const pool = (declared: SupportPool, exclude: string) => supportEntries(store, declared, exclude);

describe('the support pool', () => {
  it('is frequency-ordered, excludes the target, and is bounded', async () => {
    const entry = entryFor('我');
    const support = await pool({ ids: knownIds() }, entry.id);
    expect(support.some((row) => row.id === entry.id)).toBe(false);
    const ranks = support.map((row) => row.freqRank ?? Number.MAX_SAFE_INTEGER);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(SUPPORT_CAP).toBeGreaterThan(0);
  });

  it('never turns a known headword into every reading of it', async () => {
    const kan = readingOf('看', 'kan4');
    const kanOther = readingOf('看', 'kan1');
    const ids = (await pool({ ids: [kan.id] }, '')).map((row) => row.id);
    expect(ids).toEqual([kan.id]);
    expect(ids).not.toContain(kanOther.id);
  });

  it('takes a headword only when it has one reading, for a caller with no ids', async () => {
    // The fallback is deliberately lossy: "the learner knows 看" does not say
    // which 看, and guessing is what put an unmet reading on a card back.
    const ambiguous = await pool({ headwords: ['看'] }, '');
    expect(ambiguous).toEqual([]);

    const unambiguous = await pool({ headwords: ['学习'] }, '');
    expect(unambiguous.map((row) => row.simp)).toEqual(['学习']);
  });

  it('expands a band per entry, and lets a card outrank it', async () => {
    const wo = entryFor('我');
    const banded = await pool({ knownBand: 1 }, '');
    // The expansion happens and every row really is in the band. The count is
    // `SUPPORT_CAP + 1` rather than the whole band — see "the band read is
    // bounded" below, which is where that number is justified. The moved
    // version of this case asserted `> 50` against an unbounded read.
    expect(banded.length).toBe(SUPPORT_CAP + 1);
    for (const row of banded) expect(row.hskBand).toBe(1);
    expect(banded.some((row) => row.id === wo.id)).toBe(true);

    // 看 kān is band 6: a band-1 expansion cannot reach it however common the
    // characters are.
    expect(banded.some((row) => row.id === readingOf('看', 'kan1').id)).toBe(false);

    const excluded = await pool({ knownBand: 1, excludeIds: [wo.id] }, '');
    expect(excluded.some((row) => row.id === wo.id)).toBe(false);
  });

  it('assumes nothing for band 0, which is the default', async () => {
    // `KnownBand` is `HskBand | 0` and 0 means "assume nothing"; the route's old
    // `parseBody` reached the same answer by dropping an out-of-range band.
    expect(await pool({ knownBand: 0 }, '')).toEqual([]);
  });
});

describe('what actually goes on the wire', () => {
  it('is cut to SUPPORT_CAP, after the ordering rather than before it', async () => {
    // The cap is the contract's and the server rejects anything over it, so the
    // cut belongs to whoever assembles the pool — a client that forgot it would
    // 400 on the learner's most ordinary review. Ordered first, so what survives
    // is the vocabulary a natural sentence reaches for.
    const offered = await offeredSupport(store, { knownBand: 2 }, '');
    expect(offered).toHaveLength(SUPPORT_CAP);
    const ranks = offered.map((row) => row.freqRank ?? Number.MAX_SAFE_INTEGER);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);

    const whole = await supportEntries(store, { knownBand: 2 }, '');
    expect(whole.length).toBeGreaterThan(SUPPORT_CAP);
    expect(offered.map((row) => row.id)).toEqual(whole.slice(0, SUPPORT_CAP).map((row) => row.id));
  });
});

describe('the band read is bounded', () => {
  /**
   * **An adversarial reviewer's finding, and the test that keeps it fixed.**
   *
   * `supportEntries` reads the HSK bands the learner has assumed. It ran on the
   * server before `backend.md` B2 and read them **whole**: `knownBand: 7` is
   * 11,028 rows and 3.16 MB of JSON, marshalled to choose forty. That was
   * tolerable in process against `node:sqlite`; after the flip it runs in a
   * WebView over OPFS on the first flip of every review card, and
   * `lib/dict/query/hsk.ts` grew `limit`/`offset` warning about exactly this.
   *
   * The bound is `SUPPORT_CAP + |excludeIds| + 1` per band, and the claim is
   * that it is **exact, not an approximation**. This is the oracle for that: the
   * unbounded computation, written out longhand here, against the same
   * dictionary.
   */
  const unboundedOffered = async (knownBand: HskBand, excludeIds: string[], exclude: string) => {
    const excluded = new Set(excludeIds);
    const seen = new Set<string>([exclude]);
    const out: Entry[] = [];
    for (const band of HSK_BANDS) {
      if (band > knownBand) continue;
      for (const entry of await store.hskBand(band)) {
        if (seen.has(entry.id) || excluded.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
      }
    }
    return out
      .sort(
        (a, b) =>
          (a.freqRank ?? Number.MAX_SAFE_INTEGER) - (b.freqRank ?? Number.MAX_SAFE_INTEGER) ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, SUPPORT_CAP);
  };

  it('returns exactly what the unbounded read returned, for every band', async () => {
    for (const knownBand of HSK_BANDS) {
      const bounded = await offeredSupport(store, { knownBand }, '');
      const oracle = await unboundedOffered(knownBand, [], '');
      expect(bounded.map((row) => row.id), `band ${knownBand}`).toEqual(
        oracle.map((row) => row.id),
      );
    }
  });

  it('…and still does when the learner has cards outranking the band', async () => {
    // The exclusions are what makes the `+ |excludeIds|` term necessary: without
    // it, excluding the top forty of a band would push the true forty-first out
    // of the window and the bounded read would silently return fewer.
    const knownBand: HskBand = 3;
    const top = await offeredSupport(store, { knownBand }, '');
    const excludeIds = top.map((row) => row.id);
    expect(excludeIds).toHaveLength(SUPPORT_CAP);

    const bounded = await offeredSupport(store, { knownBand, excludeIds }, '');
    const oracle = await unboundedOffered(knownBand, excludeIds, '');
    expect(bounded.map((row) => row.id)).toEqual(oracle.map((row) => row.id));
    // And it really did move on: none of the excluded forty came back.
    for (const id of excludeIds) expect(bounded.map((row) => row.id)).not.toContain(id);
  });

  it('reads a bounded number of rows rather than the whole band', async () => {
    // The point of the fix, counted. Band 7 alone is thousands of rows.
    const counted: number[] = [];
    // Delegated explicitly rather than spread: `SqliteDictStore`'s methods live
    // on its prototype, so `{...store}` copies `status` and nothing else.
    const counting: DictStore = {
      get status() {
        return store.status;
      },
      subscribe: (listener) => store.subscribe(listener),
      open: () => store.open(),
      entries: (ids) => store.entries(ids),
      search: (query, options) => store.search(query, options),
      segment: (text, options) => store.segment(text, options),
      readingCount: (simp) => store.readingCount(simp),
      wordsContaining: (ch, options) => store.wordsContaining(ch, options),
      hskBand: async (band, options) => {
        const rows = await store.hskBand(band, options);
        counted.push(rows.length);
        return rows;
      },
    };
    await offeredSupport(counting, { knownBand: 7 }, '');
    expect(counted).toHaveLength(HSK_BANDS.length);
    for (const rows of counted) expect(rows).toBeLessThanOrEqual(SUPPORT_CAP + 1);
    const total = counted.reduce((a, b) => a + b, 0);
    // 7 bands x 41 rows, against the 11,028 the unbounded read marshalled.
    expect(total).toBeLessThanOrEqual(HSK_BANDS.length * (SUPPORT_CAP + 1));
    const whole = (await Promise.all(HSK_BANDS.map((band) => store.hskBand(band)))).reduce(
      (sum, rows) => sum + rows.length,
      0,
    );
    expect(whole).toBeGreaterThan(10_000);
    expect(total).toBeLessThan(whole / 20);
  });
});
