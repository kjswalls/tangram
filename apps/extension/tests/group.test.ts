import { describe, expect, it } from 'vitest';

import { groupSentences, sentenceAt } from '../src/core/group';
import type { Cue, ZhLine } from '../src/core/types';

const zh = (startMs: number, endMs: number, text: string): ZhLine => ({ startMs, endMs, text, words: [] });
const en = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('groupSentences', () => {
  it('joins one sentence whose English was reordered across two cues (the 1:50 / 1:52 case)', () => {
    const sentences = groupSentences(
      [zh(110_000, 112_200, '是江城大学的中文系'), zh(112_200, 115_000, '汉语言文学专业的大一新生')],
      [
        en(110_000, 113_000, "I'm a freshman in the Chinese Department"),
        en(113_000, 115_000, 'at Jiangcheng University, majoring in Chinese Language and Literature.'),
      ],
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.zh.map((line) => line.text)).toEqual(['是江城大学的中文系', '汉语言文学专业的大一新生']);
    expect(sentences[0]!.en).toHaveLength(2);
  });

  it('keeps parallel tracks with small timing slop as separate sentences', () => {
    const sentences = groupSentences(
      [zh(0, 2000, '我叫周想想'), zh(2000, 4000, '我的梦想呢'), zh(4000, 6000, '是成为记者')],
      [en(300, 2300, 'My name is Zhou Xiangxiang.'), en(2300, 4300, 'My dream'), en(4300, 6300, 'is to be a journalist.')],
    );
    expect(sentences.map((s) => s.zh.length)).toEqual([1, 1, 1]);
    expect(sentences.map((s) => s.en[0]!.text)).toEqual([
      'My name is Zhou Xiangxiang.',
      'My dream',
      'is to be a journalist.',
    ]);
  });

  it('caps a chain of linked cues', () => {
    const zhCues = Array.from({ length: 10 }, (_, i) => zh(i * 1000, i * 1000 + 1000, `句${i}`));
    const enCues = Array.from({ length: 9 }, (_, i) => en(i * 1000 + 500, i * 1000 + 1500, `s${i}`));
    const sentences = groupSentences(zhCues, enCues);
    expect(Math.max(...sentences.map((s) => s.zh.length))).toBeLessThanOrEqual(4);
    expect(sentences.flatMap((s) => s.zh).length).toBe(10);
  });

  it('folds an English-only cue into the nearest Chinese sentence and drops far ones', () => {
    const sentences = groupSentences(
      [zh(0, 2000, '你好')],
      [en(0, 2000, 'Hello'), en(2100, 2600, '(laughs)'), en(60_000, 61_000, 'credits')],
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.en.map((cue) => cue.text)).toEqual(['Hello', '(laughs)']);
  });

  it('works with no English at all', () => {
    expect(groupSentences([zh(0, 1000, '一'), zh(1000, 2000, '二')], [])).toHaveLength(2);
  });
});

describe('sentenceAt', () => {
  const sentences = groupSentences([zh(1000, 2000, 'a'), zh(3000, 4000, 'b')], []);
  it('finds the sentence playing, or the last one before a gap', () => {
    expect(sentenceAt(sentences, 500)).toBe(-1);
    expect(sentenceAt(sentences, 1500)).toBe(0);
    expect(sentenceAt(sentences, 2500)).toBe(0);
    expect(sentenceAt(sentences, 3500)).toBe(1);
  });
});
