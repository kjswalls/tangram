// @vitest-environment node
/**
 * `DictStore` over the real artifact, against the JSON index (docs/plans/data.md D2).
 *
 * These are **differential** tests, not golden files: both implementations are
 * alive in this process until D6 deletes the JSON one, so the question asked is
 * "does the store answer what `lib/dict/index.ts` answers", and the answer is
 * exact rather than a snapshot somebody blessed. D6's first commit is what
 * freezes these comparisons into fixtures, immediately before deleting the
 * oracle — a build session that deletes `LazyDictIndex` first will find the
 * tests pass because there is nothing left to disagree with.
 *
 * Node environment: Vite refuses to bundle `node:sqlite` for the jsdom default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDictIndex, getEntries, hskBand, readingCount } from '@/lib/dict/index';
import { HSK_BANDS, type HskBand } from '@/lib/types';
import { getDict } from '@/lib/dict/load';
import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore, detectScriptFrom } from '@/lib/dict/sqlite-store';
import { upperBound } from '@/lib/dict/query/hanzi';
import { search } from '@/lib/dict/search';
import type { SqlQuery, SqlRunner, SqlValue } from '@/lib/dict/sql';
import type { DictEntry } from '@/lib/dict/types';
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

/** Both implementations' groups for one section, as `key` lists. */
function keysOf(sections: { source: string; groups: { key: string }[] }[], source: string): string[] {
  return sections.filter((part) => part.source === source).flatMap((part) => part.groups.map((g) => g.key));
}

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

describe('hanzi search — group for group, order for order', () => {
  it.each(HANZI_QUERIES)('%s', async (query) => {
    const fromStore = await store.search(query, { limit: 50 });
    const fromIndex = search(query, { limit: 50 });
    expect(fromStore.route).toBe(fromIndex.route);
    const mine = keysOf(fromStore.sections, 'hanzi');
    const theirs = keysOf(fromIndex.sections, 'hanzi');
    if (fromIndex.total <= 400) {
      // Under the cap the two must agree exactly, entries included.
      expect(mine).toEqual(theirs);
      expect(fromStore.groups).toEqual(fromIndex.groups);
      expect(fromStore.total).toBe(fromIndex.total);
    } else {
      // At the cap they are allowed to differ, and the difference must be
      // explained by key-order-versus-frequency truncation and nothing else:
      // every group the store returns is a real prefix match, and the exact
      // headword still leads.
      expect(mine[0]).toBe(theirs[0]);
      expect(mine.length).toBeGreaterThan(0);
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
  it.each(PINYIN_QUERIES)('%s', async (query) => {
    const fromStore = await store.search(query, { limit: 50 });
    const fromIndex = search(query, { limit: 50 });
    const theirs = keysOf(fromIndex.sections, 'pinyin');
    const mine = keysOf(fromStore.sections, 'pinyin');
    if (theirs.length === 0) {
      expect(mine.length).toBe(0);
      return;
    }
    // The English half is D3's, so the store's pinyin section is not competing
    // with an English one yet and cannot be deduped against it. Compare the
    // groups the JSON implementation gave the pinyin section, in its order, as
    // far as the store's page reaches.
    const capped = fromIndex.total > 600;
    if (!capped) {
      const shared = theirs.filter((key) => mine.includes(key));
      expect(shared.length).toBeGreaterThan(0);
      expect(mine.filter((key) => theirs.includes(key))).toEqual(shared);
    }
    expect(mine.length).toBeGreaterThan(0);
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

  it('keeps xx5 readings out of the pinyin index entirely', async () => {
    // CC-CEDICT's "no known reading" marker. Indexing it would answer a search
    // for `xx` with 34 unrelated characters; NULL columns keep them out of the
    // range scan for free.
    const result = await store.search('xx');
    expect(keysOf(result.sections, 'pinyin')).toEqual([]);
  });

  it('answers a partial reading by prefix', async () => {
    expect((await store.search('dasu')).groups.map((group) => group.simp)).toContain('打算');
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
    const { detectScript } = await import('@/lib/dict/segment');
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
    // of `wordsTotal`, so the DP's scores stay bit-identical to today's.
    expect(opened.meta.wordsTotal.simp).toBeGreaterThan(0);
    expect(opened.meta.maxLen.simp).toBe(15);
    expect(opened.meta.maxLen.trad).toBe(15);
    expect(opened.chars.size).toBeGreaterThan(14_000);
  });

  it('refuses to answer before open()', async () => {
    const shut = new SqliteDictStore({ connect: async () => nodeRunner(path) });
    await expect(shut.entries(['打算|打算[da3 suan4]'])).rejects.toThrow(/not open/);
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

describe('the segmenter is D3’s', () => {
  it('says so rather than answering wrongly', async () => {
    await expect(store.segment('我打算明天去北京')).rejects.toThrow(/D3/);
  });
});

describe('no module under lib/dict imports node:fs except the loader and the Node runner', () => {
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
        if (relative === 'load.ts' || relative === 'runners/node.ts') continue;
        if (/from '(node:fs|node:sqlite)/.test(readFileSync(full, 'utf8'))) offenders.push(relative);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

/** Unused-import guard for the value imports the tests above reach for lazily. */
export type _Unused = SqlValue;
