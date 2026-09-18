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

import { getDictIndex, segment as jsonSegment } from './json-oracle';
import { planSegments } from '@/lib/dict/segment';
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

/**
 * The store's segmenter against the JSON one, token for token (added after D3's
 * adversarial review).
 *
 * Everything above this point is the plan's fixed cases. None of them is a
 * *differential*: they assert literals, so the store and the JSON implementation
 * can both be wrong in the same way, and the cross-script candidate precedence —
 * the chosen script must win a collision, which is `primary.get(word) ??
 * secondary.get(word)` — has exactly one fixed case guarding it. Inverting the
 * two statements in `sqlite-store.ts` passed the whole suite.
 *
 * So: a corpus built from the dictionary's own headwords, compared field for
 * field. It is the test that fails when the two implementations disagree about
 * anything at all.
 */
describe('the store segments identically to the JSON implementation', () => {
  /** Sentences built from real headwords, so the DP has real decisions to make. */
  function corpus(): string[] {
    const index = getDictIndex();
    const simp = [...index.bySimp.keys()].filter((word) => [...word].length >= 2);
    const trad = [...index.byTrad.keys()].filter((word) => [...word].length >= 2);
    const out: string[] = [
      // The fixed cases, so a regression in them shows up here too.
      '我打算明天去北京',
      '他有意见',
      '研究生命的起源',
      '他把手表给我了',
      '中华人民共和国',
      '我随便看看',
      '你好吗？',
      '买了 3 个 iPhone！',
      '我𠮟了',
      // Shapes the fixed cases do not cover.
      '',
      '   ',
      'hello, world!',
      '123 456',
      '學習中文很有意思，你覺得呢？',
      '我今天买了一个iPhone 15 Pro Max，花了 9999 元！',
      '𩽾𩾌是一种鱼',
      '打打打打打打打打打打打打打打打打打打打打',
      '一二三四五六七八九十一二三四五六七八九十',
    ];
    // 120 machine-built sentences: alternating scripts, punctuation and Latin,
    // deterministic so a failure is reproducible.
    for (let i = 0; i < 120; i += 1) {
      const pick = (list: string[], n: number) =>
        Array.from({ length: n }, (_, k) => list[(i * 97 + k * 31) % list.length]).join('');
      out.push(
        i % 3 === 0
          ? pick(simp, 6)
          : i % 3 === 1
            ? `${pick(trad, 5)}，${pick(trad, 3)}。`
            : `${pick(simp, 3)} OK ${pick(trad, 3)}！`,
      );
    }
    return out;
  }

  it('agrees on every token of every sentence', async () => {
    const sentences = corpus();
    expect(sentences.length).toBeGreaterThan(130);
    const disagreements: string[] = [];
    for (const text of sentences) {
      const mine = await store.segment(text);
      const theirs = jsonSegment(text);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        disagreements.push(
          `${JSON.stringify(text.slice(0, 40))}\n  store ${JSON.stringify(mine.tokens.map((t) => [t.text, t.via, t.entryIds.length]))}\n  json  ${JSON.stringify(theirs.tokens.map((t) => [t.text, t.via, t.entryIds.length]))}`,
        );
      }
      if (disagreements.length >= 3) break;
    }
    expect(disagreements).toEqual([]);
  }, 120_000);

  it('agrees when the script is forced the wrong way round', async () => {
    // Where the cross-script fallback does its work: a traditional passage
    // segmented as simplified and back again.
    for (const script of ['simp', 'trad'] as const) {
      for (const text of ['學習中文', '学习中文', '我打算明天去學習', '他有意見']) {
        const mine = await store.segment(text, { script });
        const theirs = jsonSegment(text, { script });
        expect(mine, `${text} as ${script}`).toEqual(theirs);
      }
    }
  });
});

/**
 * The DP itself, pinned by hand (added after D3's adversarial review).
 *
 * The inversion made `planSegments`/`route` **shared** by the store and the JSON
 * implementation — which is what stops the two disagreeing about the cutting,
 * and is also why no differential can see a change to the DP: it changes both
 * sides at once. Verified: flipping jieba's `(score, end)` tie-break so a
 * shorter word wins, and doubling the unknown-word floor, each passed every
 * other test in the suite.
 *
 * These drive `planSegments` with a hand-made `freqOf` and constants chosen so
 * the decision sits exactly on the edge. No dictionary, no store, no arithmetic
 * that could drift with the data.
 */
describe('the max-probability DP, on a knife edge', () => {
  const TOTAL = 100;
  const stats = { logTotal: Math.log(TOTAL), maxLen: 3 };
  const cut = (text: string, freqs: Record<string, number>): string =>
    planSegments(text, { script: 'simp', stats, freqOf: (word) => freqs[word] })
      .tokens.filter((token) => token.kind === 'word')
      .map((token) => token.text)
      .join('/');

  it('gives an exact tie to the LONGER word, which is jieba’s rule', () => {
    // 甲乙 is worth exactly what 甲 + (the rest) is worth: with `f = 1/total`,
    // `log f - logTotal + best[2]` equals `floor + best[1]` to the last bit. The
    // tie-break is the only thing that decides, and jieba compares `(score,
    // end)` — so the two-character word wins.
    expect(cut('甲乙丙', { 甲乙: 1 / TOTAL })).toBe('甲乙/丙');
    // …and when the long word is worth a hair more or less, the tie-break is
    // not what decided it, which is what makes the case above meaningful.
    expect(cut('甲乙丙', { 甲乙: 2 / TOTAL })).toBe('甲乙/丙');
    expect(cut('甲乙丙', { 甲乙: 0.5 / TOTAL })).toBe('甲/乙/丙');
  });

  it('weights an unknown character at exactly log(1/total)', () => {
    // One path crosses an unknown character and the other does not, so only the
    // floor separates them: 甲乙+丙(unknown) beats 甲+乙丙 iff `a > b·c`, which
    // 50 > 49 satisfies by one. Double the floor and the unknown-crossing path
    // loses by a mile.
    expect(cut('甲乙丙', { 甲乙: 50, 甲: 7, 乙丙: 7 })).toBe('甲乙/丙');
    expect(cut('甲乙丙', { 甲乙: 48, 甲: 7, 乙丙: 7 })).toBe('甲/乙丙');
  });

  it('never emits a multi-character token the candidates do not contain', () => {
    expect(cut('甲乙丙', {})).toBe('甲/乙/丙');
    expect(cut('甲乙丙', { 甲乙丙: 1000 })).toBe('甲乙丙');
  });

  it('bounds the scan at maxLen', () => {
    // `甲乙丙丁` is known and four characters long, but `maxLen` is 3, so the DP
    // never tries it — `statsFor`'s quirk, carried into `meta.max_len_*`.
    expect(cut('甲乙丙丁', { 甲乙丙丁: 1e6 })).toBe('甲/乙/丙/丁');
  });
});

/**
 * The cross-script candidate precedence (added after the same review).
 *
 * `segment()` looks a word up in the chosen script's headwords and falls back to
 * the other script's, and the store must fold its two per-script result sets in
 * the same order. Inverting them passed the entire suite, because a collision —
 * a headword that exists in BOTH scripts with a DIFFERENT `headwordFreq` — is
 * rare: there are exactly 60 in this snapshot.
 *
 * These are texts where the two orders give a different cut, found by running
 * the DP with both maps over every headword containing a collision character.
 */
describe('the chosen script wins a cross-script collision', () => {
  const SEPARATING: [string, string][] = [
    ['干么', '干/么'],
    ['特么', '特/么'],
    ['中宁', '中/宁'],
    ['乾安', '乾安'],
    ['藉由', '藉由'],
    ['大夥', '大夥'],
  ];

  it.each(SEPARATING)('%s cuts as %s under the chosen script', async (text, expected) => {
    const mine = await store.segment(text, { script: 'simp' });
    expect(mine.tokens.filter((t) => t.kind === 'word').map((t) => t.text).join('/')).toBe(expected);
    // …and it is the JSON implementation's answer, not just a literal.
    expect(mine).toEqual(jsonSegment(text, { script: 'simp' }));
  });
});
