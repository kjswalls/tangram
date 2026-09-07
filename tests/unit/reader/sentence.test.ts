import { describe, expect, it } from 'vitest';

import {
  MAX_SENTENCE_CHARS,
  isSentenceBreak,
  sentenceAt,
  sentenceForToken,
} from '@/lib/reader/sentence';

/**
 * PLAN.md §3.5. The string is half the answer; the other half is the span, and
 * every case below checks the span still points at the word — `sentence.slice(
 * offset, offset + length)` is the assertion that matters, because that is
 * exactly what the review back highlights (`lib/srs/context.ts`).
 */

/** What the card back will highlight, given this context. */
function target({ sentence, offset, length }: { sentence: string; offset: number; length: number }) {
  return sentence.slice(offset, offset + length);
}

describe('sentence bounds', () => {
  it('takes the run between two Chinese full stops, keeping the terminator', () => {
    const text = '我昨天去了公园。我打算明天去北京。今天下雨。';
    const at = text.indexOf('打算');
    const found = sentenceAt(text, at, at + 2);
    expect(found.sentence).toBe('我打算明天去北京。');
    expect(target(found)).toBe('打算');
  });

  it('breaks on every mark §3.5 names, and on none it does not', () => {
    for (const mark of ['。', '！', '？', '；', '…', '\n', '.', '!', '?']) {
      expect(isSentenceBreak(mark)).toBe(true);
      const text = `一二三${mark}我打算走`;
      const at = text.indexOf('打算');
      expect(sentenceAt(text, at, at + 2).sentence).toBe('我打算走');
    }
    // Commas hold a Chinese sentence together; cutting there throws away the
    // context the card exists to carry.
    for (const mark of ['，', '、', '：', '“', '”']) {
      expect(isSentenceBreak(mark)).toBe(false);
      const text = `一二三${mark}我打算走。`;
      const at = text.indexOf('打算');
      expect(sentenceAt(text, at, at + 2).sentence).toBe(`一二三${mark}我打算走。`);
    }
  });

  it('mixes scripts and punctuation: an ASCII stop inside a Chinese line still cuts', () => {
    const text = 'Chapter 1. 我打算明天去北京。The end!';
    const at = text.indexOf('打算');
    const found = sentenceAt(text, at, at + 2);
    expect(found.sentence).toBe('我打算明天去北京。');
    expect(target(found)).toBe('打算');
  });

  it('a text with no boundary at all is one sentence', () => {
    const text = '我打算明天去北京';
    const found = sentenceAt(text, 1, 3);
    expect(found.sentence).toBe(text);
    expect(found.offset).toBe(1);
    expect(target(found)).toBe('打算');
  });

  it('the whole text is the sentence when the token is the whole text', () => {
    const found = sentenceAt('打算', 0, 2);
    expect(found).toEqual({ sentence: '打算', offset: 0, length: 2 });
  });

  it('trims surrounding whitespace and moves the offset with it', () => {
    const text = '第一句。\n   我打算明天去北京。   \n第三句。';
    const at = text.indexOf('打算');
    const found = sentenceAt(text, at, at + 2);
    expect(found.sentence).toBe('我打算明天去北京。');
    expect(found.offset).toBe(1);
    expect(target(found)).toBe('打算');
  });

  it('a newline is a boundary, so a line is a sentence', () => {
    const text = '第一行\n我打算明天去北京\n第三行';
    const at = text.indexOf('打算');
    const found = sentenceAt(text, at, at + 2);
    expect(found.sentence).toBe('我打算明天去北京');
    expect(target(found)).toBe('打算');
  });

  it('caps at 200 characters and keeps the target inside the window', () => {
    const long = `${'一'.repeat(400)}打算${'二'.repeat(400)}。`;
    const at = long.indexOf('打算');
    const found = sentenceAt(long, at, at + 2);
    expect(found.sentence).toHaveLength(MAX_SENTENCE_CHARS);
    expect(target(found)).toBe('打算');
    // Centred: roughly as much before the word as after it.
    expect(found.offset).toBeGreaterThan(80);
    expect(found.offset).toBeLessThan(110);
  });

  it('caps a target near the start without sliding off the front', () => {
    const long = `打算${'二'.repeat(400)}。`;
    const found = sentenceAt(long, 0, 2);
    expect(found.sentence).toHaveLength(MAX_SENTENCE_CHARS);
    expect(found.offset).toBe(0);
    expect(target(found)).toBe('打算');
  });

  it('caps a target near the end without sliding off the back', () => {
    const long = `${'一'.repeat(400)}打算`;
    const at = long.indexOf('打算');
    const found = sentenceAt(long, at, at + 2);
    expect(found.sentence).toHaveLength(MAX_SENTENCE_CHARS);
    expect(found.offset).toBe(MAX_SENTENCE_CHARS - 2);
    expect(target(found)).toBe('打算');
  });

  it('a target longer than the cap is truncated at the front of the window', () => {
    const word = '字'.repeat(300);
    const found = sentenceAt(`${word}。`, 0, word.length);
    expect(found.sentence).toHaveLength(MAX_SENTENCE_CHARS);
    expect(found.offset).toBe(0);
    expect(found.length).toBe(MAX_SENTENCE_CHARS);
  });

  it('the offset survives the second trim the cap can force', () => {
    // 300 characters of run-on, with spaces where the window will land.
    const long = `${'一 '.repeat(150)}打算${' 二'.repeat(150)}。`;
    const at = long.indexOf('打算');
    const found = sentenceAt(long, at, at + 2);
    expect(found.sentence.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    expect(found.sentence.trim()).toBe(found.sentence);
    expect(target(found)).toBe('打算');
  });

  it('clamps a span that runs past the end of the text', () => {
    const found = sentenceAt('我打算', 1, 99);
    expect(found.sentence).toBe('我打算');
    expect(found.offset).toBe(1);
    expect(found.length).toBe(2);
  });

  it('clamps a negative start', () => {
    const found = sentenceAt('我打算。', -5, 2);
    expect(found.offset).toBe(0);
    expect(found.length).toBe(2);
    expect(target(found)).toBe('我打');
  });

  it('reads a token straight off the segmenter', () => {
    const text = '你好吗？我打算走。';
    const found = sentenceForToken(text, { start: 5, end: 7 });
    expect(found.sentence).toBe('我打算走。');
    expect(target(found)).toBe('打算');
  });

  it('a boundary immediately after the token closes the sentence on it', () => {
    const text = '我打算。下一句';
    const found = sentenceAt(text, 1, 3);
    expect(found.sentence).toBe('我打算。');
    expect(target(found)).toBe('打算');
  });

  it('surrogate pairs are counted in code units, as Token offsets are', () => {
    const rare = '𠮷'; // one character, two UTF-16 code units
    const text = `${rare}打算。`;
    const at = text.indexOf('打算');
    expect(at).toBe(2);
    const found = sentenceAt(text, at, at + 2);
    expect(found.sentence).toBe(text);
    expect(target(found)).toBe('打算');
  });
});
