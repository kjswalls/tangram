/**
 * `planResolve` — the importer's rule with the dictionary taken out of it.
 *
 * `abe6793`'s `resolveWord` decided the rule and read the index in one
 * function, so the rule could only be tested against 124,188 real rows. The
 * port splits them: this half decides *which* rule a word falls under and which
 * keys it needs, and `resolve.test.ts` asserts the SQL beneath it against the
 * real artifact. Both halves matter — a plan that classifies correctly and a
 * query that executes it wrongly, or the reverse, are different bugs.
 */
import { describe, expect, it } from 'vitest';

import {
  RESOLVE_MAX_WORDS,
  RESOLVE_MAX_WORD_CHARS,
  ResolveLimitError,
  checkResolveLimits,
  planResolve,
} from '@/lib/dict/resolve';

describe('which rule a word falls under', () => {
  it('sends anything with a hanzi in it down the hanzi path', () => {
    expect(planResolve(['你好', '打', '學習', '卡拉OK'])).toEqual([
      { word: '你好', kind: 'hanzi' },
      { word: '打', kind: 'hanzi' },
      { word: '學習', kind: 'hanzi' },
      // Mixed script still has a hanzi in it, so rule 1 takes it — which is
      // right: 卡拉OK is a headword and `normalizePinyin` would not parse it.
      { word: '卡拉OK', kind: 'hanzi' },
    ]);
  });

  it('sends pinyin down the pinyin path, with the keys the SQL binds', () => {
    expect(planResolve(['dǎsuàn'])).toEqual([
      { word: 'dǎsuàn', kind: 'pinyin', toned: 'da3suan4', toneless: 'dasuan' },
    ]);
    // Every spelling of one reading folds to one pair of keys — that is what
    // makes `nǐhǎo`, `ni3hao3` and `ni3 hao3` the same query.
    for (const spelling of ['nǐhǎo', 'ni3hao3', 'ni3 hao3', "ni3'hao3", 'NI3HAO3']) {
      expect(planResolve([spelling])[0], spelling).toMatchObject({
        kind: 'pinyin',
        toned: 'ni3hao3',
        toneless: 'nihao',
      });
    }
  });

  /**
   * The tone-exact/toneless distinction lives here and nowhere else: `toned` is
   * absent when the spelling named no tone, which is what tells the store there
   * is no exact answer to prefer.
   */
  it('omits the toned key when the spelling carried no tone', () => {
    expect(planResolve(['nihao'])).toEqual([
      { word: 'nihao', kind: 'pinyin', toneless: 'nihao' },
    ]);
    expect(planResolve(['le'])[0]).not.toHaveProperty('toned');
    /**
     * The neutral tone is the case worth pinning. It contributes **no digit**
     * (`lib/dict/pinyin.ts`), so `le5`'s toned key is the string `le` — equal
     * to its own toneless key and to bare `le`'s. The two are still different
     * questions, and that is the point: `py_toned = 'le'` is every reading
     * spelled with the neutral tone, while `py_toneless = 'le'` is 了, 乐, 勒
     * and the rest. Spelling the tone narrows even when it adds no character.
     */
    expect(planResolve(['le5'])[0]).toMatchObject({ toned: 'le', toneless: 'le' });
  });

  it('folds ü, v and u: the way the stored keys were written', () => {
    for (const spelling of ['nǚ', 'nv3', 'nu:3']) {
      expect(planResolve([spelling])[0], spelling).toMatchObject({ toned: 'nu3', toneless: 'nu' });
    }
  });

  it('matches nothing for English, junk or an empty word', () => {
    expect(planResolve(['hello', 'xyzzyq', '', '   ', '?!'])).toEqual([
      { word: 'hello', kind: 'none' },
      { word: 'xyzzyq', kind: 'none' },
      { word: '', kind: 'none' },
      { word: '', kind: 'none' },
      { word: '?!', kind: 'none' },
    ]);
  });

  it('trims, and answers one ask per word in the order asked', () => {
    const words = ['  打算 ', 'le', 'nope'];
    expect(planResolve(words).map((ask) => [ask.word, ask.kind])).toEqual([
      ['打算', 'hanzi'],
      ['le', 'pinyin'],
      ['nope', 'none'],
    ]);
  });
});

describe('the caps', () => {
  it('passes a request at exactly the cap', () => {
    expect(() =>
      checkResolveLimits(Array.from({ length: RESOLVE_MAX_WORDS }, () => '你')),
    ).not.toThrow();
    expect(() => checkResolveLimits(['x'.repeat(RESOLVE_MAX_WORD_CHARS)])).not.toThrow();
  });

  it('names which cap was passed, so a caller can say something useful', () => {
    try {
      checkResolveLimits(Array.from({ length: RESOLVE_MAX_WORDS + 1 }, () => '你'));
      expect.unreachable('the word cap did not fire');
    } catch (error) {
      expect(error).toBeInstanceOf(ResolveLimitError);
      expect((error as ResolveLimitError).limit).toBe('words');
    }
    try {
      checkResolveLimits(['x'.repeat(RESOLVE_MAX_WORD_CHARS + 1)]);
      expect.unreachable('the length cap did not fire');
    } catch (error) {
      expect((error as ResolveLimitError).limit).toBe('word-chars');
    }
  });

  /**
   * A `RangeError`, so a caller that only knows the standard hierarchy still
   * classifies it as a bad argument rather than as a dictionary failure — which
   * matters because the importer shows one of those as a banner.
   */
  it('is a RangeError', () => {
    expect(new ResolveLimitError('words', 'x')).toBeInstanceOf(RangeError);
  });
});
