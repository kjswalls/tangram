/**
 * Segmentation, against the real dictionary and its jieba frequencies.
 *
 * The cases are PLAN.md §4 (row P1) plus the two classic ambiguities the DP has to
 * get right — 研究/生命 over 研究生/命 and 把/手表 over 把手/表 — which is exactly
 * what a max-probability route buys over longest-match.
 */
import { describe, expect, it } from 'vitest';

import { getDictIndex } from '@/lib/dict/index';
import { detectScript, segment } from '@/lib/dict/segment';
import { requireDictData } from './data-required';

requireDictData();

/** The segmentation as `a/b/c`, words only — how jieba's own tests are written. */
function cut(text: string): string {
  return segment(text)
    .tokens.filter((token) => token.kind === 'word')
    .map((token) => token.text)
    .join('/');
}

describe('word segmentation', () => {
  it('cuts the acceptance sentences the way jieba does', () => {
    expect(cut('我打算明天去北京')).toBe('我/打算/明天/去/北京');
    expect(cut('他有意见')).toBe('他/有/意见');
    expect(cut('研究生命的起源')).toBe('研究/生命/的/起源');
  });

  it('prefers 把/手表 to 把手/表', () => {
    const words = cut('他把手表给我了').split('/');
    expect(words).toContain('把');
    expect(words).toContain('手表');
    expect(words).not.toContain('把手');
  });

  it('keeps a known word whole rather than splitting it into characters', () => {
    expect(cut('中华人民共和国')).toBe('中华人民共和国');
    expect(cut('我随便看看')).toBe('我/随便/看看');
  });
});

describe('tokens', () => {
  it('gives a polyphone every reading it has, frequency-ordered and untruncated', () => {
    const token = segment('我想了一下').tokens.find((candidate) => candidate.text === '了');
    expect(token).toBeDefined();
    expect(token?.entryIds.length).toBeGreaterThanOrEqual(2);
    // Both of the readings a learner has to choose between are on the token…
    const readings = (token?.entryIds ?? []).map(
      (id) => getDictIndex().entries.get(id)?.pinyinNum,
    );
    expect(readings).toContain('le5');
    expect(readings).toContain('liao3');
    // …and nothing was dropped: the token carries the whole index entry for 了.
    expect(token?.entryIds).toEqual(getDictIndex().bySimp.get('了'));
    expect(token?.via).toBe('entry');
  });

  it('passes punctuation through as text, never looked up', () => {
    const tokens = segment('你好吗？').tokens;
    expect(tokens.map((token) => token.text)).toEqual(['你好', '吗', '？']);
    const punctuation = tokens[tokens.length - 1];
    expect(punctuation.kind).toBe('text');
    expect(punctuation.entryIds).toEqual([]);
  });

  it('passes Latin, digits and spaces through in one text run', () => {
    const tokens = segment('买了 3 个 iPhone！').tokens;
    expect(tokens.map((token) => token.kind)).toEqual(['word', 'word', 'text', 'word', 'text']);
    // One run, not one token per character class: the trailing ！ is part of the
    // same non-CJK stretch as the Latin before it and is never looked up either.
    expect(tokens.filter((token) => token.kind === 'text').map((token) => token.text)).toEqual([
      ' 3 ',
      ' iPhone！',
    ]);
  });

  it('reports offsets that slice the original string back out', () => {
    const text = '他把手表给我了。真的吗？';
    for (const token of segment(text).tokens) {
      expect(text.slice(token.start, token.end)).toBe(token.text);
    }
    expect(segment(text).tokens[0].start).toBe(0);
  });

  it('counts offsets in UTF-16 units and never splits a surrogate pair', () => {
    // 𠮟 is outside the BMP and is not in CC-CEDICT: it must come back as one
    // unknown word token two code units wide, not as two half-characters.
    const text = `我𠮟了`;
    const tokens = segment(text).tokens;
    expect(tokens.map((token) => token.text)).toEqual(['我', '𠮟', '了']);
    const unknown = tokens[1];
    expect(unknown.kind).toBe('word');
    expect(unknown.via).toBe('fallback');
    expect(unknown.entryIds).toEqual([]);
    expect(unknown.end - unknown.start).toBe(2);
    expect(text.slice(unknown.start, unknown.end)).toBe('𠮟');
  });

  it('answers an empty string with no tokens', () => {
    expect(segment('').tokens).toEqual([]);
  });
});

describe('script', () => {
  it('follows the script the text is written in', () => {
    const index = getDictIndex();
    expect(detectScript(index, '他有意見')).toBe('trad');
    expect(detectScript(index, '他有意见')).toBe('simp');
    // Nothing to go on (both scripts write these the same way) → the app default.
    expect(detectScript(index, '我的')).toBe('simp');
  });

  it('segments traditional text against the traditional headwords', () => {
    const result = segment('我打算明天去學習');
    expect(result.script).toBe('trad');
    expect(result.tokens.map((token) => token.text)).toEqual(['我', '打算', '明天', '去', '學習']);
    const xuexi = result.tokens[4];
    expect(xuexi.entryIds).toEqual(getDictIndex().byTrad.get('學習'));
    expect(getDictIndex().entries.get(xuexi.entryIds[0])?.simp).toBe('学习');
  });

  it('can be told which script to use', () => {
    expect(segment('學習', { script: 'simp' }).script).toBe('simp');
  });
});
