// @vitest-environment node
/**
 * Segmentation, against the real dictionary and its jieba frequencies, through
 * the **store** (docs/plans/data.md D3).
 *
 * The cases are PLAN.md §4 (row P1) plus the two classic ambiguities the DP has to
 * get right — 研究/生命 over 研究生/命 and 把/手表 over 把手/表 — which is exactly
 * what a max-probability route buys over longest-match.
 *
 * **Rewritten mechanically for D3, and no expected value changed.** The suite
 * could not pass unedited: it contained no `async` or `await` anywhere, called a
 * synchronous `segment(text)`, called `detectScript(index, …)` with a
 * `DictIndex`, and asserted against `getDictIndex().bySimp.get('了')` — all of
 * which the inversion changes. Demanding "unchanged" would only have produced a
 * suite still pointed at the JSON path, testing nothing this phase built. So the
 * permitted edits were: the import block; `async`/`await` on the tests and on
 * `cut()`; `store.segment` for `segment`; and `detectScriptFrom(chars, text)`
 * for `detectScript(index, text)`. Review it as a diff: **every** changed line
 * is one of those. No string literal, number or `toBe`/`toEqual` argument moved,
 * and no case was removed or weakened — two were added.
 *
 * **The two index oracles stay `getDictIndex()`**, against D3's own suggested
 * edit. D3 says to replace them with "the ids behind `store.search('了')`'s
 * exact hanzi group, which D1 guarantees is `bySimp.get('了')` in the same
 * order" — and that is not true: a search *group* is one `trad|simp` headword,
 * while `bySimp.get('了')` spans every traditional form of the simplified one
 * (了 has four entries across 了 and 瞭). The suggested oracle returns two ids
 * where the token carries four, so taking it would have weakened the assertion
 * to fit. `lib/dict/index.ts` is alive until D6, which is the phase that freezes
 * these comparisons into fixtures; until then it is the oracle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDictIndex } from '@/lib/dict/index';
import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore, detectScriptFrom } from '@/lib/dict/sqlite-store';
import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

let store: SqliteDictStore;
let chars: Parameters<typeof detectScriptFrom>[0];

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
  chars = (store.opened as NonNullable<SqliteDictStore['opened']>).chars;
});

afterAll(async () => {
  await store.close();
});

/** The segmentation as `a/b/c`, words only — how jieba's own tests are written. */
async function cut(text: string): Promise<string> {
  return (await store.segment(text)).tokens
    .filter((token) => token.kind === 'word')
    .map((token) => token.text)
    .join('/');
}

describe('word segmentation', () => {
  it('cuts the acceptance sentences the way jieba does', async () => {
    expect(await cut('我打算明天去北京')).toBe('我/打算/明天/去/北京');
    expect(await cut('他有意见')).toBe('他/有/意见');
    expect(await cut('研究生命的起源')).toBe('研究/生命/的/起源');
  });

  it('prefers 把/手表 to 把手/表', async () => {
    const words = (await cut('他把手表给我了')).split('/');
    expect(words).toContain('把');
    expect(words).toContain('手表');
    expect(words).not.toContain('把手');
  });

  it('keeps a known word whole rather than splitting it into characters', async () => {
    expect(await cut('中华人民共和国')).toBe('中华人民共和国');
    expect(await cut('我随便看看')).toBe('我/随便/看看');
  });
});

describe('tokens', () => {
  it('gives a polyphone every reading it has, frequency-ordered and untruncated', async () => {
    const token = (await store.segment('我想了一下')).tokens.find(
      (candidate) => candidate.text === '了',
    );
    expect(token).toBeDefined();
    expect(token?.entryIds.length).toBeGreaterThanOrEqual(2);
    // Both of the readings a learner has to choose between are on the token…
    const readings = (await store.entries(token?.entryIds ?? [])).map((entry) => entry.pinyinNum);
    expect(readings).toContain('le5');
    expect(readings).toContain('liao3');
    // …and nothing was dropped: the token carries the whole index entry for 了.
    expect(token?.entryIds).toEqual(getDictIndex().bySimp.get('了'));
    expect(token?.via).toBe('entry');
  });

  it('passes punctuation through as text, never looked up', async () => {
    const tokens = (await store.segment('你好吗？')).tokens;
    expect(tokens.map((token) => token.text)).toEqual(['你好', '吗', '？']);
    const punctuation = tokens[tokens.length - 1];
    expect(punctuation.kind).toBe('text');
    expect(punctuation.entryIds).toEqual([]);
  });

  it('passes Latin, digits and spaces through in one text run', async () => {
    const tokens = (await store.segment('买了 3 个 iPhone！')).tokens;
    expect(tokens.map((token) => token.kind)).toEqual(['word', 'word', 'text', 'word', 'text']);
    // One run, not one token per character class: the trailing ！ is part of the
    // same non-CJK stretch as the Latin before it and is never looked up either.
    expect(tokens.filter((token) => token.kind === 'text').map((token) => token.text)).toEqual([
      ' 3 ',
      ' iPhone！',
    ]);
  });

  it('reports offsets that slice the original string back out', async () => {
    const text = '他把手表给我了。真的吗？';
    for (const token of (await store.segment(text)).tokens) {
      expect(text.slice(token.start, token.end)).toBe(token.text);
    }
    expect((await store.segment(text)).tokens[0].start).toBe(0);
  });

  it('counts offsets in UTF-16 units and never splits a surrogate pair', async () => {
    // 𠮟 is outside the BMP and is not in CC-CEDICT: it must come back as one
    // unknown word token two code units wide, not as two half-characters.
    const text = `我𠮟了`;
    const tokens = (await store.segment(text)).tokens;
    expect(tokens.map((token) => token.text)).toEqual(['我', '𠮟', '了']);
    const unknown = tokens[1];
    expect(unknown.kind).toBe('word');
    expect(unknown.via).toBe('fallback');
    expect(unknown.entryIds).toEqual([]);
    expect(unknown.end - unknown.start).toBe(2);
    expect(text.slice(unknown.start, unknown.end)).toBe('𠮟');
  });

  it('answers an empty string with no tokens', async () => {
    expect((await store.segment('')).tokens).toEqual([]);
  });
});

describe('script', () => {
  it('follows the script the text is written in', () => {
    expect(detectScriptFrom(chars, '他有意見')).toBe('trad');
    expect(detectScriptFrom(chars, '他有意见')).toBe('simp');
    // Nothing to go on (both scripts write these the same way) → the app default.
    expect(detectScriptFrom(chars, '我的')).toBe('simp');
  });

  it('segments traditional text against the traditional headwords', async () => {
    const result = await store.segment('我打算明天去學習');
    expect(result.script).toBe('trad');
    expect(result.tokens.map((token) => token.text)).toEqual(['我', '打算', '明天', '去', '學習']);
    const xuexi = result.tokens[4];
    expect(xuexi.entryIds).toEqual(getDictIndex().byTrad.get('學習'));
    expect((await store.entries([xuexi.entryIds[0]]))[0]?.simp).toBe('学习');
  });

  it('can be told which script to use', async () => {
    expect((await store.segment('學習', { script: 'simp' })).script).toBe('simp');
  });

  /**
   * D3 criterion 2 — two cases ADDED, because the cross-script fallback is
   * thinly covered and the port can break it silently.
   *
   * The case above checks the returned *script* and not the cut, yet the cut is
   * what the fallback produces: a single-script candidate query would still
   * answer `'simp'` while splitting 學習 into two characters. The DP's candidate
   * map therefore spans BOTH scripts, with the chosen one winning on collision,
   * and these two assert the consequence rather than the label.
   */
  it('keeps a traditional headword whole while segmenting as simplified', async () => {
    const result = await store.segment('學習', { script: 'simp' });
    expect(result.script).toBe('simp');
    const words = result.tokens.filter((token) => token.kind === 'word');
    expect(words.map((token) => token.text)).toEqual(['學習']);
    expect(words[0].via).toBe('entry');
  });

  it('keeps a simplified headword whole while segmenting as traditional', async () => {
    const result = await store.segment('学习', { script: 'trad' });
    expect(result.script).toBe('trad');
    const words = result.tokens.filter((token) => token.kind === 'word');
    expect(words.map((token) => token.text)).toEqual(['学习']);
    expect(words[0].via).toBe('entry');
  });
});
