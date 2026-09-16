// @vitest-environment node
/**
 * `DictStore` over the real artifact, against the dictionary it was built from
 * (docs/plans/data.md D2, D6).
 *
 * These were **differential** tests against `lib/dict/index.ts`, in one process,
 * while both implementations were alive. D6 deleted the JSON one from the
 * application, and its first commit froze what it answered — so each comparison
 * below now reads one of two oracles, and which one it reads is the whole
 * subject of this paragraph:
 *
 *  - **the live JSON index**, imported through `./json-oracle`, wherever the
 *    fact is a restatement of `data/dict.json` (entries by id, a band in order,
 *    the readings of a headword, a candidate set). `scripts/build-data.ts` still
 *    builds the artifact out of those indexes, so they did not stop existing —
 *    they stopped being *shipped* — and a live oracle survives `pnpm data`
 *    pulling a newer HSK list, which a fixture cannot;
 *  - **`golden/search.json`**, wherever the fact was decided by `search()`'s own
 *    router, section allocation and group ordering. That code is gone, and
 *    re-deriving it here would mean a second implementation that could be wrong
 *    in the same way.
 *
 * Group *contents* are asserted against `dict.json` rather than against either,
 * because `lib/dict/rank.ts`'s `materialise` is **shared**: anything it gets
 * wrong it got wrong on both sides, and a store-versus-index comparison was
 * always blind to it.
 *
 * Node environment: Vite refuses to bundle `node:sqlite` for the jsdom default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  entriesBySimp,
  exactIds,
  getDictIndex,
  getEntries,
  hskBand,
  prefixIds,
  readingCount,
} from './json-oracle';
import { expectFrozenList, goldenSearch } from './golden';
import { hasUnknownReading, normalizePinyin, readingKeys } from '@/lib/dict/pinyin';
import { MAX_HANZI_PREFIX_IDS } from '@/lib/dict/query/hanzi';
import { MAX_PINYIN_PREFIX_IDS } from '@/lib/dict/query/pinyin';
import { HSK_BANDS, type HskBand } from '@/lib/types';
import { getDict, headwordTotals } from './json-oracle';
import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore, detectScriptFrom } from '@/lib/dict/sqlite-store';
import { upperBound } from '@/lib/dict/query/hanzi';
import type { SearchGroup } from '@/lib/dict/search';
import type { SqlQuery, SqlRunner, SqlValue } from '@/lib/dict/sql';
import type { DictEntry } from '@/lib/dict/types';
import { SCHEMA_VERSION } from '@/lib/dict/artifact';
import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

const path = dictArtifactPath();
let store: SqliteDictStore;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(path) });
  await store.open();
});

afterAll(async () => {
  await store.close();
});

/** A runner that counts round trips, wrapping the real one. */
function countingRunner(): { runner: SqlRunner; calls: () => number; batches: () => SqlQuery[][] } {
  const inner = nodeRunner(path);
  const seen: SqlQuery[][] = [];
  return {
    runner: {
      async query(batch: readonly SqlQuery[], signal?: AbortSignal) {
        seen.push([...batch]);
        return inner.query(batch, signal);
      },
      close: () => inner.close(),
    },
    calls: () => seen.length,
    batches: () => seen,
  };
}

/**
 * The fixed query list. Every trap in `data.md` D2 §"Pinyin normalization" has a
 * row here, plus the astral-plane prefix case and the polyphone grouping.
 */
const HANZI_QUERIES = [
  '打算',
  '打',
  '了',
  '學習',
  '学习',
  '中',
  '我',
  '𩽾', // astral: 𩽾 and 𩽾𩾌, the prefix trap below
  '𧿹', // astral with three headwords: 𧿹, 𧿹外翻, 𧿹趾
  '龘',
  '爸爸',
  '中华人民共和国',
];

const PINYIN_QUERIES = [
  'dasuan',
  'da3suan4',
  'dǎsuàn',
  'da3 suan4',
  'DaSuan',
  'wǒmen',
  'wo3men',
  'women',
  'xian',
  "xi1'an1",
  'lu:4',
  'lv4',
  'lǜ',
  'nu:3',
  'da',
  'dasu',
  'yi',
  'hé',
  'shi',
  'ni3hao3',
];

describe('entries — the store answers what getEntries answers', () => {
  it('returns the same rows, in the order asked for, for a spread of ids', async () => {
    const all = getDict().entries;
    const ids = [
      '打算|打算[da3 suan4]',
      '了|了[le5]',
      '了|了[liao3]',
      '學習|学习[xue2 xi2]',
      '綠|绿[lu:4]',
      // A proverb id whose pinyin contains commas — `parseIdList`'s own case.
      ...all.filter((entry) => entry.id.includes(',')).slice(0, 2).map((entry) => entry.id),
      // The first and last rows in `compareEntries` order.
      [...getDictIndex().entries.keys()][0],
      [...getDictIndex().entries.keys()][all.length - 1],
      'not|an[id]',
    ];
    const fromStore = await store.entries(ids);
    const fromIndex = getEntries(ids);
    expect(fromStore).toEqual(fromIndex);
    // …and unknown ids are dropped rather than returned as holes.
    expect(fromStore.length).toBe(ids.length - 1);
  });

  it('rebuilds an entry with no classifiers as [], never undefined', async () => {
    const bare = getDict().entries.find((entry) => entry.classifiers.length === 0) as DictEntry;
    const [got] = await store.entries([bare.id]);
    expect(got.classifiers).toEqual([]);
    expect(Object.hasOwn(got, 'classifiers')).toBe(true);
  });

  it('returns thousands of ids in order, across chunk boundaries', async () => {
    // `IN (…)` lists are chunked because SQLite's parameter ceiling is a
    // compile-time option and the three runtimes are three different builds —
    // 999 before SQLite 3.32, 32,766 on this one, unverified on `sqlite-wasm`
    // and the SQLCipher pod. A list this long crosses several chunks, and the
    // chunk boundaries must be invisible: same entries, same order.
    const all = [...getDictIndex().entries.keys()];
    const ids = Array.from({ length: 2_500 }, (_, i) => all[(i * 7919) % all.length]);
    const fromStore = await store.entries(ids);
    expect(fromStore).toEqual(getEntries(ids));
    expect(fromStore.length).toBe(new Set(ids).size);
    // …and one round trip, because the chunks ride in the same batch.
    const counting = countingRunner();
    const spiedStore = new SqliteDictStore({ connect: async () => counting.runner });
    await spiedStore.open();
    const before = counting.calls();
    await spiedStore.entries(ids);
    expect(counting.calls() - before).toBe(1);
    expect(counting.batches()[counting.batches().length - 1].length).toBeGreaterThan(1);
    await spiedStore.close();
  });

  it('answers an empty id list without touching the runner', async () => {
    const counting = countingRunner();
    const quiet = new SqliteDictStore({ connect: async () => counting.runner });
    await quiet.open();
    const before = counting.calls();
    expect(await quiet.entries([])).toEqual([]);
    expect(counting.calls()).toBe(before);
    await quiet.close();
  });
});

describe('hskBand — all seven bands in full', () => {
  // In full, not a sample: the 51 entries with no `freqRank` are the only rows
  // where `ORDER BY hsk_sort, rowid` and `byHsk`'s re-sort can disagree, and six
  // of them are in band 1 — the band product-decisions §3 sends every beginner to.
  it.each(HSK_BANDS)('band %i matches getDictIndex().byHsk exactly', async (band: HskBand) => {
    const fromStore = await store.hskBand(band);
    const fromIndex = hskBand(band);
    expect(fromStore.length).toBe(fromIndex.length);
    expect(fromStore.map((entry) => entry.id)).toEqual(fromIndex.map((entry) => entry.id));
    expect(fromStore).toEqual(fromIndex);
  });

  it('pages with limit and offset without changing the order', async () => {
    const whole = hskBand(7);
    const page = await store.hskBand(7, { limit: 50, offset: 100 });
    expect(page.map((entry) => entry.id)).toEqual(whole.slice(100, 150).map((entry) => entry.id));
    const tail = await store.hskBand(1, { offset: 500 });
    expect(tail.map((entry) => entry.id)).toEqual(hskBand(1).slice(500).map((entry) => entry.id));
  });
});

describe('readingCount — readings, not rows', () => {
  const HEADWORDS = ['看', '发', '了', '后', '里', '面', '出', '云', '打算', '学习', '不存在的'];
  it.each(HEADWORDS)('%s', async (simp) => {
    expect(await store.readingCount(simp)).toBe(readingCount(simp));
  });
});

describe('wordsContaining — no counterpart in the JSON index, so a brute-force oracle', () => {
  /** Every entry whose headword in `script` contains `ch`, in rowid order. */
  function expected(ch: string, script: 'simp' | 'trad', limit: number): string[] {
    const index = getDictIndex();
    const out: string[] = [];
    for (const entry of index.entries.values()) {
      const headword = script === 'simp' ? entry.simp : entry.trad;
      if (headword.includes(ch)) out.push(entry.id);
      if (out.length >= limit) break;
    }
    return out;
  }

  const CHARACTERS = [
    '算', '打', '的', '我', '人', '學', '学', '习', '習', '龘', '爸', '鱼', '魚',
    '国', '國', '𩽾', '一', '心', '水', '火',
  ];

  it.each(CHARACTERS)('%s, simplified', async (ch) => {
    const got = await store.wordsContaining(ch, { script: 'simp', limit: 40 });
    expect(got.map((entry) => entry.id)).toEqual(expected(ch, 'simp', 40));
    expect(got.every((entry) => entry.simp.includes(ch))).toBe(true);
  });

  it('answers for traditional headwords too, and differs where the scripts do', async () => {
    const trad = await store.wordsContaining('學', { script: 'trad', limit: 20 });
    expect(trad.map((entry) => entry.id)).toEqual(expected('學', 'trad', 20));
    expect(trad.length).toBeGreaterThan(0);
    // 學 is not a simplified headword character, so the simplified side is empty.
    expect(await store.wordsContaining('學', { script: 'simp', limit: 20 })).toEqual([]);
  });

  it('answers nothing for a character no headword contains', async () => {
    expect(await store.wordsContaining('Ω', { script: 'simp' })).toEqual([]);
  });
});

/**
 * Did the JSON side's prefix walk actually stop at the cap?
 *
 * The obvious gate — `SearchResult.total` against 400 or 600 — is wrong, and
 * wrong in the direction that hides bugs: `total` is a **deduped group count
 * summed over every section**, while the caps count **ids per script**. On the
 * pinyin route `total` also carries the English section's groups, which the
 * store has none of until D3. Measured, the two disagree in both directions —
 * `无` is capped at 400 ids with a total of 397, `lu:4` is uncapped at 442 ids
 * with a total of 483 — so a `total`-based gate runs the strict rule on
 * truncated queries and the loose rule on exact ones.
 *
 * So the predicate asks the JSON implementation directly, with its own
 * `prefixIds`, which is the function that does the truncating.
 */
function sortedHeadwords(map: Map<string, string[]>): { keys: string[]; ids: string[][] } {
  const keys = [...map.keys()].sort();
  return { keys, ids: keys.map((key) => map.get(key) as string[]) };
}

function hanziPrefixIds(query: string): number {
  const index = getDictIndex();
  return Math.max(
    prefixIds(sortedHeadwords(index.bySimp), query, MAX_HANZI_PREFIX_IDS).length,
    prefixIds(sortedHeadwords(index.byTrad), query, MAX_HANZI_PREFIX_IDS).length,
  );
}

/**
 * What the store's candidate queries MUST return, derived from the JSON index
 * alone.
 *
 * The capped branch needs this. "Every group is a prefix match" is true of a
 * store that kept the four hundred *least* frequent matches — verified: mutating
 * the prefix query to `ORDER BY rowid DESC` passed every other assertion in this
 * file. `index.entries` is a Map built in `compareEntries` order, so a walk over
 * it is a walk in rowid order, which is exactly what `ORDER BY rowid LIMIT n`
 * takes.
 */
function idsByRowidOrder(matches: (entry: DictEntry) => boolean, limit: number): string[] {
  const out: string[] = [];
  for (const entry of getDictIndex().entries.values()) {
    if (!matches(entry)) continue;
    out.push(entry.id);
    if (out.length >= limit) break;
  }
  return out;
}

/** The exact groups a correct store returns for a hanzi query, capped or not. */
function expectedHanziKeys(query: string): Set<string> {
  const index = getDictIndex();
  const ids = new Set<string>([
    ...(index.bySimp.get(query) ?? []),
    ...(index.byTrad.get(query) ?? []),
    ...idsByRowidOrder((entry) => entry.simp.startsWith(query), MAX_HANZI_PREFIX_IDS),
    ...idsByRowidOrder((entry) => entry.trad.startsWith(query), MAX_HANZI_PREFIX_IDS),
  ]);
  const keys = new Set<string>();
  for (const id of ids) {
    const entry = index.entries.get(id) as DictEntry;
    keys.add(`${entry.trad}|${entry.simp}`);
  }
  return keys;
}

/** The same for a pinyin query, over whichever key column the query uses. */
function expectedPinyinKeys(query: string): Set<string> {
  const index = getDictIndex();
  const pinyin = normalizePinyin(query);
  const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
  const wanted = toned ? pinyin.toned : pinyin.toneless;
  const keyOf = (entry: DictEntry): string | null => {
    if (hasUnknownReading(entry.pinyinNum)) return null;
    const computed = readingKeys(entry.pinyinNum) ?? normalizePinyin(entry.pinyinNum);
    return (toned ? computed.toned : computed.toneless) || null;
  };
  const ids = new Set<string>([
    ...(toned ? exactIds(index.byPinyinToned, pinyin.toned) : []),
    ...exactIds(index.byPinyinToneless, pinyin.toneless),
    ...idsByRowidOrder((entry) => (keyOf(entry) ?? '').startsWith(wanted), MAX_PINYIN_PREFIX_IDS),
  ]);
  const keys = new Set<string>();
  for (const id of ids) {
    const entry = index.entries.get(id) as DictEntry;
    keys.add(`${entry.trad}|${entry.simp}`);
  }
  return keys;
}

/**
 * The headword keys the JSON router would have put in a hanzi query's section,
 * derived from `dict.json` (docs/plans/data.md D6).
 *
 * The capped report below is a *diagnostic* — it prints how the two truncations
 * differ — and the criterion beside it is `expectedHanziKeys`, which is the
 * store's own determined set. So this only has to reproduce `prefixIds`: whole
 * key buckets in lexicographic order until the cap, plus the exact matches. It
 * is deliberately not a re-implementation of `search()`; nothing asserts equality
 * against it.
 */
function jsonHanziKeys(query: string): string[] {
  const index = getDictIndex();
  const ids = new Set<string>([
    ...(index.bySimp.get(query) ?? []),
    ...(index.byTrad.get(query) ?? []),
    ...prefixIds(sortedHeadwords(index.bySimp), query, MAX_HANZI_PREFIX_IDS),
    ...prefixIds(sortedHeadwords(index.byTrad), query, MAX_HANZI_PREFIX_IDS),
  ]);
  return [...ids].map((id) => {
    const entry = index.entries.get(id) as DictEntry;
    return `${entry.trad}|${entry.simp}`;
  });
}

/** The same for a pinyin query, over whichever key column the query uses. */
function jsonPinyinKeys(query: string): string[] {
  const index = getDictIndex();
  const pinyin = normalizePinyin(query);
  if (!pinyin.fullyParsed) return [];
  const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
  const ids = new Set<string>([
    ...(toned ? exactIds(index.byPinyinToned, pinyin.toned) : []),
    ...exactIds(index.byPinyinToneless, pinyin.toneless),
    ...prefixIds(
      toned ? index.byPinyinToned : index.byPinyinToneless,
      toned ? pinyin.toned : pinyin.toneless,
      MAX_PINYIN_PREFIX_IDS,
    ),
  ]);
  return [...ids].map((id) => {
    const entry = index.entries.get(id) as DictEntry;
    return `${entry.trad}|${entry.simp}`;
  });
}

function pinyinPrefixIds(query: string): number {
  const pinyin = normalizePinyin(query);
  if (!pinyin.fullyParsed) return 0;
  const index = getDictIndex();
  const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
  return prefixIds(
    toned ? index.byPinyinToned : index.byPinyinToneless,
    toned ? pinyin.toned : pinyin.toneless,
    MAX_PINYIN_PREFIX_IDS,
  ).length;
}

/** A page big enough that neither implementation's section is cut by paging. */
const WHOLE = { limit: 100_000 };

/**
 * A group's contents, against `data/dict.json` directly.
 *
 * This replaces the `expect(mine).toEqual(theirs)` that compared a store group
 * against a JSON-index group, and it is stronger rather than weaker: both sides
 * built their groups with `lib/dict/rank.ts`'s `materialise`, so that comparison
 * could not see a bug in the thing they share. The claims here are about the
 * dictionary — a group is one `trad|simp` headword, it carries **every** reading
 * of it, and its badge is the easiest band among them (PLAN.md §3.2).
 */
function expectGroupContent(group: SearchGroup, source: string): void {
  expect(group.source, group.key).toBe(source);
  expect(`${group.trad}|${group.simp}`, 'the key is the headword').toBe(group.key);
  const readings = entriesBySimp(group.simp).filter((entry) => entry.trad === group.trad);
  expect(
    [...group.entries.map((entry) => entry.id)].sort(),
    `${group.key}: every reading of the headword, nothing added and nothing lost`,
  ).toEqual([...readings.map((entry) => entry.id)].sort());
  // Every row is the dictionary's row, field for field.
  for (const entry of group.entries) {
    expect(entry, `${group.key}: ${entry.id}`).toEqual(getEntries([entry.id])[0]);
  }
  const bands = readings.map((entry) => entry.hskBand).filter((band) => band !== undefined);
  expect(group.hskBand, `${group.key}: the easiest band among the readings`).toBe(
    bands.length > 0 ? Math.min(...bands) : undefined,
  );
  // Matched ids are a subset of the group, and never empty.
  expect(group.matchedIds.length, `${group.key}: matchedIds`).toBeGreaterThan(0);
  const ids = new Set(group.entries.map((entry) => entry.id));
  for (const id of group.matchedIds) expect(ids.has(id), `${group.key}: ${id}`).toBe(true);
}

function sectionOf(result: { sections: { source: string; groups: SearchGroup[] }[] }, source: string): SearchGroup[] {
  return result.sections.filter((part) => part.source === source).flatMap((part) => part.groups);
}

describe('hanzi search — group for group, order for order', () => {
  it.each(HANZI_QUERIES)('%s', async (query) => {
    const fromStore = await store.search(query, WHOLE);
    const frozen = goldenSearch.hanzi[query];
    expect(frozen, `${query} has no frozen answer in golden/search.json`).toBeDefined();
    expect(fromStore.route).toBe(frozen.route);
    expect(fromStore.sections.map((part) => part.source)).toEqual(frozen.sections);
    const mine = sectionOf(fromStore, 'hanzi');

    // Every group is the dictionary's, whatever the cap did. This is what the
    // old `expect(mine).toEqual(theirs)` was reaching for, asserted against the
    // data rather than against the other implementation.
    for (const group of mine) expectGroupContent(group, 'hanzi');

    if (hanziPrefixIds(query) < MAX_HANZI_PREFIX_IDS) {
      // Under the cap the store must answer exactly what the JSON router
      // answered — keys and order, digested over the whole list.
      expectFrozenList(mine.map((group) => group.key), frozen.hanziKeys, `hanzi ${query}`);
      return;
    }

    // At the cap, equality is not the criterion and must not be asserted: the
    // JSON walk kept the alphabetically-first headwords and `ORDER BY rowid
    // LIMIT` keeps the most frequent, so the frozen list is the wrong question.
    // What IS asserted is that the store's set is exactly the one a correct
    // store returns.
    expect(mine.length).toBeGreaterThan(0);
    // Fully determined even at the cap: the exact matches plus the 400
    // lowest-rowid prefix matches per script, derived from `dict.json`. Without
    // it, "every group is a prefix match" is equally true of a store that kept
    // the 400 LEAST frequent matches — verified: mutating the prefix query to
    // `ORDER BY rowid DESC` passed every other assertion in this file.
    expect(new Set(mine.map((group) => group.key))).toEqual(expectedHanziKeys(query));
    for (const group of mine) {
      expect(group.simp.startsWith(query) || group.trad.startsWith(query)).toBe(true);
    }
    // The exact headword still leads, which is the property a learner notices.
    if (getDictIndex().bySimp.has(query) || getDictIndex().byTrad.has(query)) {
      expect(mine[0].simp === query || mine[0].trad === query).toBe(true);
    }
  });

  it('keeps the exact headword above the words that start with it', async () => {
    const result = await store.search('打算');
    expect(result.groups[0].simp).toBe('打算');
    expect(result.groups.map((group) => group.simp)).toContain('打算盘');
  });

  it('groups a polyphone into one result carrying every reading', async () => {
    const group = (await store.search('了')).groups[0];
    expect(group.key).toBe('了|了');
    const readings = group.entries.map((entry) => entry.pinyinMarked);
    expect(readings).toContain('le');
    expect(readings).toContain('liǎo');
    expect(group.hskBand).toBe(1);
  });

  it('carries a band computed from every reading, checked against dict.json directly', async () => {
    // Not a differential assertion, deliberately. `rank.ts` is SHARED by the two
    // implementations, so anything it gets wrong it gets wrong on both sides and
    // a store-versus-index comparison is blind to it — verified: forcing
    // `materialise` to stamp `hskBand: 1` on every group passes every
    // differential test in this file. The oracle here is the raw JSON.
    const byHeadword = new Map<string, number[]>();
    for (const entry of getDict().entries) {
      const key = `${entry.trad}|${entry.simp}`;
      const bands = byHeadword.get(key) ?? [];
      if (entry.hskBand !== undefined) bands.push(entry.hskBand);
      byHeadword.set(key, bands);
    }
    for (const query of ['打算', '了', '学习', '中', '我', '爸爸']) {
      for (const group of (await store.search(query, { limit: 100 })).groups) {
        const bands = byHeadword.get(group.key) ?? [];
        const want = bands.length > 0 ? Math.min(...bands) : undefined;
        expect(group.hskBand, `${query} → ${group.key}`).toBe(want);
      }
    }
  });

  it('accepts traditional input and answers with the simplified headword', async () => {
    const result = await store.search('學習');
    expect(result.groups[0].simp).toBe('学习');
    expect(result.groups[0].trad).toBe('學習');
    expect(result.groups[0].entries[0].hskBand).toBe(1);
  });
});

describe('the prefix range trap', () => {
  // A prefix scan is a range scan, and the upper bound must be the prefix with
  // its last code point incremented — NOT the prefix with U+FFFF appended.
  // `U+FFFF` is `EF BF BF` in UTF-8 and any astral character is `F0 …`, and
  // `F0 > EF`, so the naive sentinel drops exactly the headwords whose
  // continuation is itself an extension character.
  it('increments the last code point rather than appending U+FFFF', () => {
    expect(upperBound('da')).toBe('db');
    expect(upperBound('打')).toBe(String.fromCodePoint(0x6254));
    // A surrogate pair is one code point, and stays one.
    expect([...upperBound('𩽾')].length).toBe(1);
    expect(upperBound('𩽾')).toBe(String.fromCodePoint(0x29f7f));
    expect(() => upperBound('')).toThrow();
  });

  it('is a trap in SQLite’s collation, not in JavaScript’s', async () => {
    // Worth being exact about, because a test written in JavaScript can "prove"
    // the wrong thing here. `<` on JS strings compares UTF-16 code units, where
    // a surrogate lead (0xD867) is BELOW U+FFFF — so in JS the naive bound looks
    // fine. SQLite's default BINARY collation compares UTF-8 bytes, where 𩾌 is
    // `F0 …` and U+FFFF is `EF BF BF`, and `F0 > EF`. The database is the only
    // place this can be demonstrated.
    expect('𩽾𩾌' < '𩽾\uFFFF').toBe(true); // JavaScript says the sentinel is fine…
    const runner = nodeRunner(path);
    try {
      const [naive, correct] = await runner.query([
        {
          sql: 'SELECT simp FROM entries WHERE simp >= ? AND simp < ? ORDER BY rowid',
          params: ['𩽾', '𩽾\uFFFF'],
        },
        {
          sql: 'SELECT simp FROM entries WHERE simp >= ? AND simp < ? ORDER BY rowid',
          params: ['𩽾', upperBound('𩽾')],
        },
      ]);
      // …and SQLite says it drops the very headword the extension ranges exist for.
      expect(naive.map((row) => row.simp)).not.toContain('𩽾𩾌');
      expect(correct.map((row) => row.simp)).toContain('𩽾𩾌');
      expect(correct.length).toBeGreaterThan(naive.length);
    } finally {
      await runner.close();
    }
  });

  it('finds an astral headword whose continuation is also astral', async () => {
    // 𩽾𩾌 (ānkāng, the anglerfish). Both characters are outside the BMP.
    const simps = (await store.search('𩽾')).groups.map((group) => group.simp);
    expect(simps).toContain('𩽾');
    expect(simps).toContain('𩽾𩾌');
  });

  it('finds all three headwords under an astral prefix', async () => {
    const simps = (await store.search('𧿹')).groups.map((group) => group.simp);
    expect(simps).toContain('𧿹');
    expect(simps).toContain('𧿹趾');
    expect(simps).toContain('𧿹外翻');
  });
});

describe('pinyin search — the section matches the JSON one', () => {
  // What "matches" can mean here, precisely, because the obvious assertion is
  // both too strong and too weak:
  //
  // - too strong, because the JSON side runs an English section alongside the
  //   pinyin one and `dedupe` gives a headword to whichever ranked it higher —
  //   so the JSON's pinyin section is a SUBSET of the store's, which has no
  //   English competitor until D3;
  // - too weak if it only compares the intersection, which is what an earlier
  //   version of this block did. Measured: with `pinyinPrefix` mutated to
  //   `LIMIT 1` the store dropped 打算盘 from `dasuan`, three of four groups from
  //   `dasu` and half of `nu:3`, and every assertion still passed.
  //
  // So: containment, the relative order of the shared keys, and every reading of
  // every shared group.
  it.each(PINYIN_QUERIES)('%s', async (query) => {
    const fromStore = await store.search(query, WHOLE);
    const frozen = goldenSearch.pinyin[query];
    expect(frozen, `${query} has no frozen answer in golden/search.json`).toBeDefined();
    expect(fromStore.route).toBe(frozen.route);
    const mine = sectionOf(fromStore, 'pinyin');
    const mineKeys = mine.map((group) => group.key);
    const theirKeys = frozen.pinyinKeys.head;

    // The store's pinyin CANDIDATE set is fully determined — the exact tiers plus
    // the 600 lowest-rowid prefix matches — but the pinyin SECTION is not the
    // candidate set: since D3 both implementations run an English section
    // alongside, and `dedupe` gives a headword to whichever ranked it higher. So
    // the oracle is checked against the whole result, in both directions.
    const oracle = expectedPinyinKeys(query);
    const everywhere = new Set([...mineKeys, ...sectionOf(fromStore, 'english').map((g) => g.key)]);
    expect(
      [...oracle].filter((key) => !everywhere.has(key)),
      `${query}: the store lost pinyin candidates entirely`,
    ).toEqual([]);
    expect(
      mineKeys.filter((key) => !oracle.has(key)),
      `${query}: the pinyin section holds groups no pinyin query could have found`,
    ).toEqual([]);

    // Every group is the dictionary's headword, its full set of readings and the
    // easiest band among them — the half of the old per-group comparison that
    // was about the data rather than about the other implementation.
    for (const group of mine) expectGroupContent(group, 'pinyin');

    if (pinyinPrefixIds(query) >= MAX_PINYIN_PREFIX_IDS) {
      // At the cap the two implementations' candidate sets differ by design, so
      // the frozen list is the wrong question; the oracle above is the criterion.
      expect(mine.length).toBeGreaterThan(0);
      return;
    }

    // Containment against the frozen answer. This is the assertion the LIMIT-1
    // mutation fails immediately. `frozen.pinyinKeys.head` is the first twenty
    // keys the JSON router returned, in its order; under the cap the store must
    // still hold all of them, in the same relative order.
    const missing = theirKeys.filter((key) => !mineKeys.includes(key));
    expect(missing, `${query}: the store lost groups the JSON index found`).toEqual([]);
    expect(mineKeys.filter((key) => theirKeys.includes(key))).toEqual(theirKeys);
  });

  it('orders a group’s readings by frequency where the JSON index orders them by key', async () => {
    // The second face of D2's one behavioural change, pinned by name rather than
    // tolerated in an aggregate. A headword's readings sit under DIFFERENT
    // pinyin keys when one of them is neutral-tone — 女人 is `nu:3 ren2`
    // (`nu3ren2`) and `nu:3 ren5` (`nu3ren`) — and `prefixIds` walks whole key
    // buckets in lexicographic KEY order while `ORDER BY rowid` is frequency
    // order. So the two put the same two readings in a different order inside
    // the group, on a query nowhere near the cap.
    //
    // Four queries in this suite's list show it: nu:3, hé, men2, guai1, one
    // group each. If that count grows, something else has changed.
    const mine = sectionOf(await store.search('nu:3', WHOLE), 'pinyin');
    const key = '女人|女人';
    const a = mine.find((group) => group.key === key) as SearchGroup;
    // The JSON side's order, recorded as a literal because the implementation
    // that produced it is gone (D6). It walked whole key buckets, and 女人's two
    // readings sit under `nu3ren` and `nu3ren2`, so `nu:3 ren5` came first.
    const jsonOrder = ['nu:3 ren5', 'nu:3 ren2'];
    expect(a.entries.map((entry) => entry.pinyinNum)).toEqual(['nu:3 ren2', 'nu:3 ren5']);
    // …and the two orders are permutations of one another, never different sets.
    expect([...a.entries.map((entry) => entry.pinyinNum)].sort()).toEqual([...jsonOrder].sort());
  });

  it('finds 打算 first however the reading is typed', async () => {
    for (const query of ['dasuan', 'da3suan4', 'dǎsuàn', 'da3 suan4', 'DaSuan']) {
      const groups = (await store.search(query)).groups;
      expect(groups[0].simp, query).toBe('打算');
    }
  });

  it('ranks tone-exact above toneless above prefix', async () => {
    expect((await store.search('da3suan4')).groups[0].simp).toBe('打算');
    const toneless = (await store.search('dasuan')).groups.map((group) => group.simp);
    expect(toneless).toContain('大蒜');
    expect(toneless.indexOf('打算')).toBeLessThan(toneless.indexOf('大蒜'));
    // 打算盘 arrives only through the prefix tier, so it is what a broken prefix
    // query loses first.
    expect(toneless).toContain('打算盘');
  });

  it('keeps neutral-tone words reachable from tone marks', async () => {
    // `wo3 men5` keys as `wo3men`, so a learner typing `wǒmen` must land on it.
    expect((await store.search('wǒmen')).groups[0].simp).toBe('我们');
  });

  it('folds ü, u: and v onto one reading', async () => {
    for (const query of ['lu:4', 'lv4', 'lǜ']) {
      const found = (await store.search(query)).groups.flatMap((group) =>
        group.entries.map((entry) => entry.id),
      );
      expect(found, query).toContain('綠|绿[lu:4]');
    }
  });

  it('keeps xx5 readings out of both key columns entirely', async () => {
    // CC-CEDICT's "no known reading" marker. Indexing it would answer a search
    // for `xx` with 34 unrelated characters. Asserted against the columns rather
    // than through `search('xx')` — `xx` does not parse as pinyin, so that query
    // never reaches the pinyin index and the test could not fail.
    const runner = nodeRunner(path);
    try {
      const [indexed, headword] = await runner.query([
        {
          sql: "SELECT count(*) AS n FROM entries WHERE pinyin_num LIKE '%xx5%' AND (py_toneless IS NOT NULL OR py_toned IS NOT NULL)",
        },
        { sql: "SELECT count(*) AS n FROM entries WHERE pinyin_num LIKE '%xx5%'" },
      ]);
      expect(indexed[0].n).toBe(0);
      // …and there really are such entries, so the zero above means something.
      expect(headword[0].n).toBeGreaterThan(0);
    } finally {
      await runner.close();
    }
    // The headword itself is still findable by hanzi, which is the point: it has
    // no reading, not no existence. 働 is one (a Japanese-made character
    // CC-CEDICT carries with no Mandarin reading) and it IS inside
    // `CJK_PATTERN`, unlike 々 and the era ligatures, which route to English.
    expect((await store.search('働')).groups.map((group) => group.simp)).toContain('働');
    expect((await store.search('働')).groups[0].entries[0].pinyinMarked).toBe('');
  });

  it('answers a partial reading by prefix', async () => {
    expect((await store.search('dasu')).groups.map((group) => group.simp)).toContain('打算');
  });
});

/**
 * D2 criterion 4: "the phase records the diff and one line of justification per
 * query" for every query that hits the cap. This is that record, computed rather
 * than transcribed, so it cannot go stale.
 */
describe('the capped queries, and why each one differs', () => {
  const CAPPED_HANZI = ['中', '无', '高', '一'];
  const CAPPED_PINYIN = ['xian', 'da', 'yi', 'shi', 'zhi', 'shu'];

  it('every capped hanzi query differs only by frequency-versus-key truncation', async () => {
    const report: string[] = [];
    for (const query of CAPPED_HANZI) {
      expect(hanziPrefixIds(query), `${query} was expected to hit the cap`).toBe(
        MAX_HANZI_PREFIX_IDS,
      );
      const mine = sectionOf(await store.search(query, WHOLE), 'hanzi');
      // The JSON side's set, derived from `dict.json` the way `prefixIds` did:
      // whole key buckets in lexicographic order until 400 ids are taken.
      const theirKeys = new Set(jsonHanziKeys(query));
      const mineKeys = new Set(mine.map((group) => group.key));
      const onlyMine = [...mineKeys].filter((key) => !theirKeys.has(key));
      const onlyTheirs = [...theirKeys].filter((key) => !mineKeys.has(key));
      // Every group the store returns is a real prefix match — the only
      // permitted explanation is which 400 ids each kept — and the store's set
      // must be exactly the most frequent 400 per script.
      for (const group of mine) {
        expect(group.simp.startsWith(query) || group.trad.startsWith(query)).toBe(true);
      }
      expect(mineKeys).toEqual(expectedHanziKeys(query));
      report.push(
        `  ${query}: store ${mine.length} groups, json ${theirKeys.size}; ` +
          `${onlyMine.length} only in the store (more frequent), ${onlyTheirs.length} only in the JSON (earlier by key)`,
      );
    }
    // Written straight to stdout so the phase's writeup can quote it and a later
    // session can re-run it. `console.log` is captured by the test runner.
    process.stdout.write(
      `\ncapped hanzi queries (cap ${MAX_HANZI_PREFIX_IDS} ids per script):\n${report.join('\n')}\n`,
    );
  });

  it('every capped pinyin query differs only by frequency-versus-key truncation', async () => {
    const report: string[] = [];
    for (const query of CAPPED_PINYIN) {
      expect(pinyinPrefixIds(query), `${query} was expected to hit the cap`).toBe(
        MAX_PINYIN_PREFIX_IDS,
      );
      const mine = sectionOf(await store.search(query, WHOLE), 'pinyin');
      const theirKeys = new Set(jsonPinyinKeys(query));
      const mineKeys = new Set(mine.map((group) => group.key));
      const onlyMine = [...mineKeys].filter((key) => !theirKeys.has(key));
      const onlyTheirs = [...theirKeys].filter((key) => !mineKeys.has(key));
      const pinyin = normalizePinyin(query);
      const toned = pinyin.syllables.some((syllable) => syllable.tone !== null);
      const wanted = toned ? pinyin.toned : pinyin.toneless;
      // Every group the store returns carries a reading whose key starts with
      // the query's key. Anything else would be a different bug wearing the
      // truncation's clothes.
      for (const group of mine) {
        const keys = group.entries.map((entry) => {
          const computed = readingKeys(entry.pinyinNum) ?? normalizePinyin(entry.pinyinNum);
          return toned ? computed.toned : computed.toneless;
        });
        expect(
          keys.some((key) => key.startsWith(wanted)),
          `${group.key} carries no reading under ${wanted}`,
        ).toBe(true);
      }
      report.push(
        `  ${query}: store ${mine.length} groups, json ${theirKeys.size}; ` +
          `${onlyMine.length} only in the store (more frequent), ${onlyTheirs.length} only in the JSON (earlier by key)`,
      );
    }
    process.stdout.write(
      `\ncapped pinyin queries (cap ${MAX_PINYIN_PREFIX_IDS} ids):\n${report.join('\n')}\n`,
    );
  });
});

describe('detectScript from the chars table', () => {
  it('reproduces the JSON index’s verdict', () => {
    const chars = (store.opened as { chars: Parameters<typeof detectScriptFrom>[0] }).chars;
    expect(detectScriptFrom(chars, '他有意見')).toBe('trad');
    expect(detectScriptFrom(chars, '他有意见')).toBe('simp');
    // Nothing to go on — both scripts write these the same way → the app default.
    expect(detectScriptFrom(chars, '我的')).toBe('simp');
    expect(detectScriptFrom(chars, '')).toBe('simp');
    expect(detectScriptFrom(chars, 'hello')).toBe('simp');
  });

  it('agrees with detectScript on every single-character headword', async () => {
    const { detectScript } = await import('./json-oracle');
    const index = getDictIndex();
    const chars = (store.opened as { chars: Parameters<typeof detectScriptFrom>[0] }).chars;
    const disagreements: string[] = [];
    for (const ch of chars.keys()) {
      if (detectScriptFrom(chars, ch) !== detectScript(index, ch)) disagreements.push(ch);
    }
    expect(disagreements).toEqual([]);
  });
});

describe('the round-trip budget', () => {
  // The only defence against per-keystroke bridge chatter, and it must fail if
  // someone adds a third call. `data.md` D2's table says `wordsContaining` is
  // one; it is two, because the posting list is a BLOB only TypeScript can
  // decode — see HANDOFF.md, D2.
  async function trips(work: (store: SqliteDictStore) => Promise<unknown>): Promise<number> {
    const counting = countingRunner();
    const spied = new SqliteDictStore({ connect: async () => counting.runner });
    await spied.open();
    const before = counting.calls();
    await work(spied);
    const after = counting.calls() - before;
    await spied.close();
    return after;
  }

  it('opens in one', async () => {
    const counting = countingRunner();
    const spied = new SqliteDictStore({ connect: async () => counting.runner });
    await spied.open();
    expect(counting.calls()).toBe(1);
    expect(counting.batches()[0]).toHaveLength(2);
    await spied.close();
  });

  it('entries, hskBand and readingCount are one each', async () => {
    expect(await trips((s) => s.entries(['打算|打算[da3 suan4]']))).toBe(1);
    expect(await trips((s) => s.hskBand(1, { limit: 10 }))).toBe(1);
    expect(await trips((s) => s.readingCount('看'))).toBe(1);
  });

  it('search is two — candidates, then the page’s readings', async () => {
    expect(await trips((s) => s.search('打'))).toBe(2);
    expect(await trips((s) => s.search('dasuan'))).toBe(2);
    expect(await trips((s) => s.search('da3suan4'))).toBe(2);
  });

  it('a search with no results spends only the candidate trip', async () => {
    expect(await trips((s) => s.search('龘龘龘'))).toBe(1);
  });

  it('wordsContaining is two, and the first batch is one statement', async () => {
    const counting = countingRunner();
    const spied = new SqliteDictStore({ connect: async () => counting.runner });
    await spied.open();
    await spied.wordsContaining('算', { script: 'simp', limit: 5 });
    const batches = counting.batches().slice(1);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    await spied.close();
  });

  it('every batch a hanzi search issues goes in one call', async () => {
    const counting = countingRunner();
    const spied = new SqliteDictStore({ connect: async () => counting.runner });
    await spied.open();
    await spied.search('打');
    const batches = counting.batches().slice(1);
    // Three candidate statements — exact, simp prefix, trad prefix — in ONE
    // round trip, which is the whole point of a batch.
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(1);
    await spied.close();
  });
});

describe('caching and cancellation', () => {
  it('serves a repeated query from the cache without a round trip', async () => {
    const counting = countingRunner();
    const cached = new SqliteDictStore({ connect: async () => counting.runner });
    await cached.open();
    await cached.search('打算');
    const after = counting.calls();
    await cached.search('打算');
    expect(counting.calls()).toBe(after);
    await cached.close();
  });

  it('coalesces two identical in-flight queries into one', async () => {
    const counting = countingRunner();
    const cached = new SqliteDictStore({ connect: async () => counting.runner });
    await cached.open();
    const before = counting.calls();
    const [a, b] = await Promise.all([cached.hskBand(2, { limit: 5 }), cached.hskBand(2, { limit: 5 })]);
    expect(counting.calls() - before).toBe(1);
    expect(a).toEqual(b);
    await cached.close();
  });

  it('hands out a frozen result, so one caller cannot poison the next', async () => {
    // A cache returns the SAME object to every later caller. Without this, a
    // consumer calling `.sort()` on a returned list — or emptying it — would
    // corrupt every subsequent answer for the life of the session, and the
    // symptom would look like a dictionary bug.
    const first = await store.hskBand(3, { limit: 5 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as DictEntry[]).length = 0;
    }).toThrow();
    expect((await store.hskBand(3, { limit: 5 })).length).toBe(5);
  });

  it('refuses an already-aborted search even when the answer is cached', async () => {
    // A call that rejects when cold and resolves when warm is the worst kind of
    // flake: it is correct on the first keystroke and wrong on the second.
    const warmed = await store.search('中', { limit: 10 });
    expect(warmed.groups.length).toBeGreaterThan(0);
    const controller = new AbortController();
    controller.abort();
    await expect(store.search('中', { limit: 10, signal: controller.signal })).rejects.toThrow();
  });

  it('refuses an already-aborted search rather than running it', async () => {
    const counting = countingRunner();
    const cancellable = new SqliteDictStore({ connect: async () => counting.runner });
    await cancellable.open();
    const controller = new AbortController();
    controller.abort();
    await expect(cancellable.search('中', { signal: controller.signal })).rejects.toThrow();
    await cancellable.close();
  });

  it('does not open twice when two callers race open()', async () => {
    const counting = countingRunner();
    const once = new SqliteDictStore({ connect: async () => counting.runner });
    await Promise.all([once.open(), once.open(), once.open()]);
    expect(counting.calls()).toBe(1);
    await once.close();
  });
});

describe('open() and the meta constants', () => {
  it('reads the snapshot, the counts and the segmenter’s constants', () => {
    const opened = store.opened as NonNullable<SqliteDictStore['opened']>;
    expect(store.status).toEqual({ state: 'ready', version: getDict().meta.version });
    expect(opened.meta.dictVersion).toBe(getDict().meta.version);
    expect(opened.meta.entryCount).toBe(getDict().entries.length);
    expect(opened.meta.schemaVersion).toBe(1);
    // Constants of the snapshot, not of the code. The client takes Math.log()
    // of `wordsTotal`, so the DP's scores stay bit-identical to today's only if
    // these are exact — and the two scripts must be asserted separately, since
    // `maxLen` happens to be 15 for both and a store that read `max_len_simp`
    // twice would pass a symmetric assertion.
    const index = getDictIndex();
    expect(opened.meta.wordsTotal.simp).toBe(headwordTotals(index, 'simp').total);
    expect(opened.meta.wordsTotal.trad).toBe(headwordTotals(index, 'trad').total);
    expect(opened.meta.wordsTotal.simp).not.toBe(opened.meta.wordsTotal.trad);
    expect(opened.meta.maxLen.simp).toBe(headwordTotals(index, 'simp').maxLen);
    expect(opened.meta.maxLen.trad).toBe(headwordTotals(index, 'trad').maxLen);
    expect(opened.chars.size).toBe(
      new Set(
        [...index.bySimp.keys(), ...index.byTrad.keys()].filter((word) => [...word].length === 1),
      ).size,
    );
  });

  it('refuses to answer before open()', async () => {
    const shut = new SqliteDictStore({ connect: async () => nodeRunner(path) });
    await expect(shut.entries(['打算|打算[da3 suan4]'])).rejects.toThrow(/not open/);
  });

  it('refuses an artifact built by a different SCHEMA_VERSION', async () => {
    // Nothing else would notice: the file opens, every query answers, and the
    // answers are shaped by a schema this build does not know.
    const wrongSchema = new SqliteDictStore({
      connect: async () => ({
        query: async () => [
          [
            { key: 'schema_version', value: String(SCHEMA_VERSION + 1) },
            { key: 'dict_version', value: '1.3.20251213' },
            { key: 'entry_count', value: '1' },
            { key: 'words_total_simp', value: '1' },
            { key: 'words_total_trad', value: '1' },
            { key: 'max_len_simp', value: '1' },
            { key: 'max_len_trad', value: '1' },
          ],
          [],
        ],
        close: async () => {},
      }),
    });
    await expect(wrongSchema.open()).rejects.toThrow(/schema/);
    expect(wrongSchema.status.state).toBe('failed');
  });

  it('closes the connection it opened when open() fails', async () => {
    // On OPFS the pool holds an exclusive lock per origin and on Capacitor the
    // plugin holds a native handle, so a leaked connection is not garbage —
    // it is a retry that can never succeed.
    let closed = 0;
    const leaky = new SqliteDictStore({
      connect: async () => ({
        query: async () => {
          throw new Error('the file is not a database');
        },
        close: async () => {
          closed += 1;
        },
      }),
    });
    await expect(leaky.open()).rejects.toThrow();
    expect(closed).toBe(1);
  });

  it('recovers from a connect() that throws synchronously', async () => {
    // An async function runs synchronously to its first suspension, so a
    // `connect()` that throws before awaiting used to latch a rejected promise
    // into the in-flight slot and wedge every later open() on a store that
    // could have recovered.
    let attempts = 0;
    const flaky = new SqliteDictStore({
      connect: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('no bytes yet');
        return Promise.resolve(nodeRunner(path));
      },
    });
    await expect(flaky.open()).rejects.toThrow('no bytes yet');
    await flaky.open();
    expect(flaky.status).toEqual({ state: 'ready', version: getDict().meta.version });
    expect(attempts).toBe(2);
    await flaky.close();
  });

  it('close() during a pending open() really closes, and does not flip back to ready', async () => {
    let closed = 0;
    let release: (() => void) | undefined;
    const slow = new SqliteDictStore({
      connect: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const inner = nodeRunner(path);
        return {
          query: (batch, signal) => inner.query(batch, signal),
          close: async () => {
            closed += 1;
            await inner.close();
          },
        };
      },
    });
    const opening = slow.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = slow.close();
    release?.();
    await opening;
    await closing;
    expect(slow.status).toEqual({ state: 'absent' });
    expect(closed).toBe(1);
  });

  it('reports failure rather than throwing past the status', async () => {
    const broken = new SqliteDictStore({
      connect: () => Promise.reject(new Error('no bytes on this device')),
    });
    await expect(broken.open()).rejects.toThrow('no bytes');
    expect(broken.status).toEqual({
      state: 'failed',
      reason: 'corrupt',
      message: 'no bytes on this device',
    });
  });

  it('tells subscribers every state it passes through', async () => {
    const seen: string[] = [];
    const watched = new SqliteDictStore({ connect: async () => nodeRunner(path) });
    const unsubscribe = watched.subscribe((status) => seen.push(status.state));
    await watched.open();
    await watched.close();
    unsubscribe();
    expect(seen).toEqual(['preparing', 'ready', 'absent']);
    await watched.open();
    expect(seen).toEqual(['preparing', 'ready', 'absent']);
    await watched.close();
  });
});

describe('no module under lib/dict imports node:fs except the Node runner', () => {
  // D2 criterion 6, as a standing assertion: the store and the query layer are
  // shared with a browser worker and a WebView, and a stray `node:fs` import is
  // a build that fails at bundle time on a platform nobody is testing today.
  it('holds across the whole directory', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { appRoot } = await import('@/lib/server/roots');
    const root = resolve(appRoot(), 'lib/dict');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const relative = full.slice(root.length + 1);
        // `data.md` D6 deleted `load.ts`; `runners/node.ts` is the only
        // exemption left, and criterion 2 names it.
        if (relative === 'runners/node.ts') continue;
        // Any quote style, and dynamic `import('node:…')` as well as static
        // — a guard that only sees one spelling is a guard that passes the day
        // someone writes the other.
        if (/(?:from|import\s*\(|require\s*\()\s*['"`]node:(?:fs|sqlite|path|os|crypto|child_process)/.test(readFileSync(full, 'utf8'))) {
          offenders.push(relative);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

/** Unused-import guard for the value imports the tests above reach for lazily. */
export type _Unused = SqlValue;
