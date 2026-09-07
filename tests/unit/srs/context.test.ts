import { describe, expect, it } from 'vitest';

import {
  contextLabel,
  contextText,
  maskFor,
  maskedContext,
  resolveContext,
  splitContext,
} from '@/lib/srs/context';
import type { CardContext } from '@/lib/types';

const SENTENCE = '我打算明天去北京。';
const NOW = Date.UTC(2026, 8, 7, 12);

const context = (patch: Partial<CardContext> = {}): CardContext => ({
  sentence: SENTENCE,
  offset: 1,
  length: 2,
  source: 'reader',
  addedAt: NOW,
  ...patch,
});

describe('contextText', () => {
  it('prefers the sentence, then the question, then the query', () => {
    expect(contextText(context())).toBe(SENTENCE);
    expect(contextText({ question: 'how do I say…', source: 'ask', addedAt: NOW })).toBe(
      'how do I say…',
    );
    expect(contextText({ query: 'dasuan', source: 'lookup', addedAt: NOW })).toBe('dasuan');
    expect(contextText({ source: 'seed', addedAt: NOW })).toBeNull();
    expect(contextText(undefined)).toBeNull();
    expect(contextText({ sentence: '   ', source: 'reader', addedAt: NOW })).toBeNull();
  });

  it('labels where the line came from', () => {
    expect(contextLabel(context())).toBe('From the sentence');
    expect(contextLabel({ question: 'q', source: 'ask', addedAt: NOW })).toBe('From the question');
    expect(contextLabel({ query: 'q', source: 'lookup', addedAt: NOW })).toBe('From the lookup');
  });
});

describe('splitContext', () => {
  it('splits on offset and length when the reader recorded them', () => {
    expect(splitContext(SENTENCE, 1, 2)).toEqual({
      before: '我',
      target: '打算',
      after: '明天去北京。',
    });
  });

  it('falls back to finding the headword when there are no offsets', () => {
    expect(splitContext(SENTENCE, undefined, undefined, '北京')).toEqual({
      before: '我打算明天去',
      target: '北京',
      after: '。',
    });
  });

  it('refuses offsets that fall outside the text rather than highlighting nonsense', () => {
    expect(splitContext(SENTENCE, 40, 2)).toBeNull();
    expect(splitContext(SENTENCE, 8, 5)).toBeNull();
    expect(splitContext(SENTENCE, -1, 2)).toBeNull();
    expect(splitContext(SENTENCE, 1, 0)).toBeNull();
    expect(splitContext(SENTENCE, 1.5, 2)).toBeNull();
  });

  it('is null when the target is nowhere in the text', () => {
    expect(splitContext(SENTENCE, undefined, undefined, '上海')).toBeNull();
    expect(splitContext(SENTENCE)).toBeNull();
  });

  it('prefers the recorded offsets over the first occurrence', () => {
    // 看 appears twice; the reader tapped the second one.
    const parts = splitContext('我看着你看', 4, 1, '看');
    expect(parts).toEqual({ before: '我看着你', target: '看', after: '' });
  });
});

describe('the mask', () => {
  it('is one box per character of the target', () => {
    expect(maskFor('打算')).toBe('＿＿');
    expect(maskFor('看')).toBe('＿');
  });

  it('hides the target and nothing else', () => {
    const masked = maskedContext(splitContext(SENTENCE, 1, 2));
    expect(masked).toBe('我＿＿明天去北京。');
    expect(masked).not.toContain('打算');
  });

  it('has nothing to show when the target could not be located', () => {
    expect(maskedContext(null)).toBeNull();
  });
});

describe('resolveContext', () => {
  it('resolves the line, the split and the label in one go', () => {
    const resolved = resolveContext(context(), ['打算']);
    expect(resolved?.text).toBe(SENTENCE);
    expect(resolved?.label).toBe('From the sentence');
    expect(resolved?.parts?.target).toBe('打算');
  });

  it('tries the other script when the first target is not in the sentence', () => {
    const resolved = resolveContext(
      { sentence: '我买书。', source: 'reader', addedAt: NOW },
      ['書', '书'],
    );
    expect(resolved?.parts).toEqual({ before: '我买', target: '书', after: '。' });
  });

  it('keeps the line but skips the split when nothing matches', () => {
    const resolved = resolveContext({ sentence: '我买书。', source: 'reader', addedAt: NOW }, ['茶']);
    expect(resolved?.text).toBe('我买书。');
    expect(resolved?.parts).toBeNull();
  });

  it('is null without a context', () => {
    expect(resolveContext(undefined, ['打算'])).toBeNull();
    expect(resolveContext({ source: 'seed', addedAt: NOW }, ['打算'])).toBeNull();
  });
});
