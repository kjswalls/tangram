// @vitest-environment node
/**
 * `DictStore.resolve` — the list importer's rule, against the real artifact.
 *
 * **This file was `resolve-frozen.test.ts`** (`wave-zero.md` §8b), the guard
 * that held `resolve` declared-and-not-implemented until the porting phase
 * arrived. The implementation has landed, so the guard is gone — but its intent
 * is not, and replacing one without the other is how a feature ships hollow.
 * The intent was: **no stub can pass for this feature.** Every case below is
 * written so that an empty result, a plausible-looking shape, or a `search`
 * wearing `resolve`'s signature fails it:
 *
 *   - real entry ids are asserted by value, not by count;
 *   - `打` must **not** come back with 打算, which is what a prefix scan would do;
 *   - a simplified list and a traditional one must produce the *same* ids;
 *   - the polyphone case asserts more than one reading and their order;
 *   - the caps reject rather than truncate, because a truncation is a silent
 *     half-import.
 *
 * The rule itself is `abe6793`'s and is ported unchanged (`wave-zero.md` §8a);
 * only the implementation beneath it changed, from the in-heap JSON index to
 * SQL over the artifact. `tests/unit/dict/resolve-rule.test.ts` covers the pure
 * half — `planResolve` — with no database at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
import {
  RESOLVE_MAX_WORDS,
  RESOLVE_MAX_WORD_CHARS,
  ResolveLimitError,
} from '@/lib/dict/resolve';
import { getDictIndex, type DictIndex } from './json-oracle';
import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

const NIHAO = '你好|你好[ni3 hao3]';
const DASUAN = '打算|打算[da3 suan4]';

let store: SqliteDictStore;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
});

afterAll(async () => {
  await store.close?.();
});

/** The JSON index, for the one case that needs the busiest reading keys. */
function index(): DictIndex {
  return getDictIndex();
}

/** One word's answer, for the cases that ask about exactly one. */
async function one(word: string) {
  const { results } = await store.resolve([word]);
  expect(results).toHaveLength(1);
  return results[0];
}

describe('rule 1 — hanzi matches exactly, in both scripts', () => {
  it('finds the headword and names the snapshot it came from', async () => {
    const { dictVersion, results } = await store.resolve(['你好']);
    expect(dictVersion).toBe(
      store.opened?.meta.dictVersion ?? '<the store did not report a version>',
    );
    expect(dictVersion).not.toBe('');
    expect(results[0]).toMatchObject({ word: '你好', via: 'hanzi' });
    expect(results[0].entries.map((entry) => entry.id)).toContain(NIHAO);
  });

  /**
   * The case the whole member exists for. `search` would answer 打 with 打算,
   * 打算盘, 打扮 and so on, because a prefix is what a person typing wants —
   * and it is exactly wrong for a list, where 打 means 打.
   */
  it('never matches by prefix: 打 is not 打算', async () => {
    const da = await one('打');
    expect(da.via).toBe('hanzi');
    expect(da.entries.length).toBeGreaterThan(0);
    expect(da.entries.every((entry) => entry.simp === '打' || entry.trad === '打')).toBe(true);
    expect(da.entries.map((entry) => entry.id)).not.toContain(DASUAN);
  });

  it('resolves a simplified list and a traditional one alike', async () => {
    const [simp, trad] = (await store.resolve(['学习', '學習'])).results;
    expect(simp.via).toBe('hanzi');
    expect(trad.via).toBe('hanzi');
    expect(simp.entries.map((entry) => entry.id)).toEqual(trad.entries.map((entry) => entry.id));
    expect(simp.entries.length).toBeGreaterThan(0);
  });

  /**
   * 干 is three traditional headwords under one simplified form, so a row filed
   * under both of its spellings could be dropped from its own bucket if the
   * dedupe were global rather than per spelling.
   */
  it('keeps every reading of a headword whose two scripts differ', async () => {
    const gan = await one('干');
    const ids = gan.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(gan.entries.every((entry) => entry.simp === '干' || entry.trad === '干')).toBe(true);
    expect(new Set(gan.entries.map((entry) => entry.trad)).size).toBeGreaterThan(1);
  });

  it('returns every reading of a polyphone, most frequent first', async () => {
    const readings = (await one('了')).entries.map((entry) => entry.pinyinNum);
    expect(new Set(readings).size).toBeGreaterThan(1);
    // Frequency order is what the picker defaults to, so the order is the
    // assertion and not an incidental detail.
    expect(readings[0]).toBe('le5');
    expect(readings).toContain('liao3');
  });
});

describe('rule 2 — pinyin, tone-exact then toneless', () => {
  it('finds 打算 however the reading is spelled', async () => {
    for (const spelling of ['dǎsuàn', 'da3suan4', 'da3 suan4', 'dasuan', "da3'suan4"]) {
      const got = await one(spelling);
      expect(got.via, spelling).toBe('pinyin');
      expect(got.entries.map((entry) => entry.id), spelling).toContain(DASUAN);
    }
  });

  /**
   * The fallback is a fallback, never a merge: tones narrow. If the toneless
   * set were unioned in, `da3suan4` would carry every headword read `dasuan`
   * and the picker would default to whichever of them is commonest.
   */
  it('tones narrow — a toned spelling never picks up toneless neighbours', async () => {
    const toned = await one('da3suan4');
    expect(toned.entries.every((entry) => entry.pinyinNum === 'da3 suan4')).toBe(true);
    const toneless = await one('dasuan');
    expect(toneless.entries.length).toBeGreaterThanOrEqual(toned.entries.length);
  });

  it('falls back when the tones name no entry at all', async () => {
    // `ni2hao3` is nobody's reading; the toneless key still finds 你好.
    const got = await one('ni2hao3');
    expect(got.via).toBe('pinyin');
    expect(got.entries.map((entry) => entry.id)).toContain(NIHAO);
  });

  it('answers a toneless syllable with every headword read that way', async () => {
    const simps = (await one('le')).entries.map((entry) => entry.simp);
    expect(simps).toContain('了');
    expect(simps).toContain('乐');
  });
});

describe('rule 3 — and nothing else is a way to name a word', () => {
  it('matches nothing for English, junk, an unknown compound or an empty word', async () => {
    const { results } = await store.resolve(['hello', 'xyzzyq', '   ', '你好吗吗吗']);
    for (const row of results) {
      expect(row, row.word).toMatchObject({ via: 'none', entries: [] });
    }
  });

  it('reports an unresolved word rather than dropping it', async () => {
    // The acceptance criterion in full: the answer is one row per word asked,
    // in the order asked, whatever happened to each of them.
    const words = ['你好', 'xyzzyq', 'le', '學習', 'dǎsuàn', ''];
    const { results } = await store.resolve(words);
    expect(results.map((row) => row.word)).toEqual(['你好', 'xyzzyq', 'le', '學習', 'dǎsuàn', '']);
    expect(results.map((row) => row.via)).toEqual([
      'hanzi',
      'none',
      'pinyin',
      'hanzi',
      'pinyin',
      'none',
    ]);
  });

  it('echoes the word trimmed, so a picker can show what was written', async () => {
    expect((await one('  打算  ')).word).toBe('打算');
  });
});

describe('the whole paste at once', () => {
  it('resolves a mixed paste line by line, each to its own candidates', async () => {
    const words = ['你好', '學習', 'dǎsuàn', 'ni3hao3', 'nihao', 'xyzzyq', '打'];
    const { results } = await store.resolve(words);
    expect(results.map((row) => row.word)).toEqual(words);
    expect(results.map((row) => row.via)).toEqual([
      'hanzi',
      'hanzi',
      'pinyin',
      'pinyin',
      'pinyin',
      'none',
      'hanzi',
    ]);
    // Each line keeps its own candidate set — this is the property `search`
    // cannot give, because it ranks across headwords and pages at 50.
    expect(results[0].entries.map((entry) => entry.id)).toContain(NIHAO);
    expect(results[2].entries.map((entry) => entry.id)).toContain(DASUAN);
    expect(results[3].entries.map((entry) => entry.id)).toContain(NIHAO);
    expect(results[4].entries.map((entry) => entry.id)).toContain(NIHAO);
    expect(results[6].entries.map((entry) => entry.id)).not.toContain(DASUAN);
  });

  it('repeats a repeated word rather than collapsing the list', async () => {
    const { results } = await store.resolve(['你好', '你好']);
    expect(results).toHaveLength(2);
    expect(results[0].entries.map((entry) => entry.id)).toEqual(
      results[1].entries.map((entry) => entry.id),
    );
  });

  it('answers an empty ask with an empty result and no more', async () => {
    // Not the stub the freeze forbade: nothing was asked about. The cases above
    // are what stop this shape passing for the feature.
    await expect(store.resolve([])).resolves.toMatchObject({ results: [] });
  });

  it('agrees with a one-at-a-time resolution of the same words', async () => {
    const words = ['你好', '了', 'dasuan', 'xyzzyq'];
    const bulk = (await store.resolve(words)).results;
    const singly = await Promise.all(words.map((word) => one(word)));
    expect(bulk).toEqual(singly);
  });

  it('spans more than one chunk without losing or reordering a word', async () => {
    // `RESOLVE_HANZI_CHUNK` is 450, so this is three statements for the hanzi
    // half alone and the ordering has to survive `byRowid` putting them back
    // together.
    const filler = Array.from({ length: 600 }, (_, i) => `龘${i}`);
    const words = ['你好', ...filler, '打算'];
    const { results } = await store.resolve(words);
    expect(results).toHaveLength(words.length);
    expect(results[0].entries.map((entry) => entry.id)).toContain(NIHAO);
    expect(results.at(-1)?.entries.map((entry) => entry.id)).toContain(DASUAN);
    expect(results.slice(1, -1).every((row) => row.via === 'none')).toBe(true);
  });
});

describe('what a pathological paste costs, measured rather than assumed', () => {
  /**
   * **The one number `wave-zero.md` §8b's bridge argument would have wanted and
   * did not have.** `resolve` caps how many words it takes; it puts no `LIMIT`
   * on how many entries come back, because a limit here would be exactly the
   * silent truncation the caps exist to prevent — a candidate dropped from a
   * picker is a reading the learner is never offered.
   *
   * So the cost is bounded by the data instead, and this records it. The worst
   * possible request is the thousand commonest toneless reading keys — a paste
   * of a thousand bare syllables, `shi`, `li`, `yi` — which is not a list
   * anybody has, but it is the ceiling.
   *
   * Measured on this artifact: **18,551 entries, ≈4.7 MB of JSON, ~200 ms** in
   * Node. A realistic seven-line paste is 5.8 KB and ~1 ms. Two things make the
   * ceiling survivable rather than merely rare: the importer chunks at
   * `RESOLVE_CHUNK` (500), so it never asks for the whole cap at once, and this
   * is a button press behind "Looking up…", not the keystroke path `data.md`
   * D4's 50 ms interactive budget governs.
   *
   * The ceiling here is generous on purpose — it is a tripwire for a schema or
   * projection change that makes the payload grow by an order of magnitude, not
   * a performance assertion. If it fires, the lever nobody has pulled is a
   * two-pass query: rank on narrow columns, then fetch full rows for the
   * survivors. It costs a second round trip, which is the budget §8b is written
   * around, so measure before believing it.
   */
  it('answers the worst possible paste, and its size is on the record', async () => {
    const keys = [...index().byPinyinToneless.keys];
    const worst = keys
      .map((key, i) => ({ key, n: index().byPinyinToneless.ids[i].length }))
      .sort((a, b) => b.n - a.n)
      .slice(0, RESOLVE_MAX_WORDS)
      .map((row) => row.key);
    expect(worst).toHaveLength(RESOLVE_MAX_WORDS);

    const answer = await store.resolve(worst);
    const entries = answer.results.reduce((total, row) => total + row.entries.length, 0);
    // Every word answered, none truncated.
    expect(answer.results).toHaveLength(RESOLVE_MAX_WORDS);
    expect(entries).toBeGreaterThan(10_000);
    const megabytes = Buffer.byteLength(JSON.stringify(answer), 'utf8') / 1e6;
    expect(megabytes, `the worst paste now serialises to ${megabytes.toFixed(1)} MB`).toBeLessThan(
      8,
    );
  });

  it('and a realistic paste costs almost nothing', async () => {
    const answer = await store.resolve(['你好', '打算', '学习', '謝謝', 'dasuan', 'le', '跑步']);
    const kilobytes = Buffer.byteLength(JSON.stringify(answer), 'utf8') / 1e3;
    expect(kilobytes, `a seven-line paste is ${kilobytes.toFixed(1)} kB`).toBeLessThan(64);
  });
});

describe('the caps reject rather than truncate', () => {
  /**
   * A silent truncation is a half-import the learner finds out about by
   * counting, which is why `wave-zero.md` §8b makes it the caller's error.
   */
  it('refuses more than RESOLVE_MAX_WORDS', async () => {
    const words = Array.from({ length: RESOLVE_MAX_WORDS + 1 }, () => '你');
    await expect(store.resolve(words)).rejects.toThrow(ResolveLimitError);
    await expect(store.resolve(words)).rejects.toMatchObject({ limit: 'words' });
    // And the cap itself is inclusive, so a caller chunking at exactly the cap
    // is not refused.
    await expect(
      store.resolve(Array.from({ length: RESOLVE_MAX_WORDS }, () => '你')),
    ).resolves.toMatchObject({ results: expect.any(Array) });
  });

  it('refuses a word longer than RESOLVE_MAX_WORD_CHARS', async () => {
    await expect(store.resolve(['x'.repeat(RESOLVE_MAX_WORD_CHARS + 1)])).rejects.toMatchObject({
      limit: 'word-chars',
    });
    await expect(store.resolve(['x'.repeat(RESOLVE_MAX_WORD_CHARS)])).resolves.toMatchObject({
      results: [{ via: 'none' }],
    });
  });

  it('carries the caps abe6793 settled, unchanged', () => {
    expect(RESOLVE_MAX_WORDS).toBe(1000);
    expect(RESOLVE_MAX_WORD_CHARS).toBe(200);
  });
});

describe('cancellation', () => {
  it('rejects an already-aborted request before it reaches the database', async () => {
    const aborted = AbortSignal.abort();
    await expect(store.resolve(['你好'], { signal: aborted })).rejects.toThrow();
  });

  /**
   * And it rejects **even when the answer is warm**, which is the property the
   * up-front check actually buys. A call that rejects when cold and resolves
   * when cached is the worst kind of flake: right on the first paste and wrong
   * on the second. `search` is guarded the same way for the same reason.
   *
   * The paste is deliberately its own, and asked for once first, so the cache
   * hit is the thing under test rather than an accident of what an earlier case
   * happened to leave in a 64-entry LRU.
   */
  it('rejects an aborted request even when the answer is already cached', async () => {
    const paste = ['謝謝', '再见', 'zaijian'];
    const warm = await store.resolve(paste);
    expect(warm.results.some((row) => row.entries.length > 0)).toBe(true);

    const controller = new AbortController();
    controller.abort();
    await expect(store.resolve(paste, { signal: controller.signal })).rejects.toThrow();
  });

  /**
   * The signal has to reach the **runner**, not merely be checked once on the
   * way in. `nodeRunner` is synchronous inside its async wrapper, so a paste it
   * is already running cannot be interrupted here — but the shipping runners
   * are a worker and a native bridge, where it can. So the runner is wrapped in
   * one that yields first, which is what those two do.
   */
  it('honours a signal aborted while the query is in flight', async () => {
    const controller = new AbortController();
    const solo = new SqliteDictStore({
      connect: async () => {
        const real = nodeRunner(dictArtifactPath());
        return {
          async query(batch, signal) {
            await Promise.resolve();
            signal?.throwIfAborted();
            return real.query(batch, signal);
          },
          close: () => real.close(),
        };
      },
    });
    await solo.open();
    const pending = solo.resolve(['打算', '你好', '學習'], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    await solo.close();
  });
});
