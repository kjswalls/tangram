/**
 * The span-select primitives (docs/plans/core.md C5b).
 *
 * The gesture itself is a Playwright criterion — `tests/e2e/core/reader-span.spec.ts`
 * for the reader and `tests/e2e/core/span-select-harness.spec.ts` for the
 * harness — because it needs real hit-testing and real layout. What is testable
 * here is the half that decides *which characters*: the character map, the
 * ranges built over it, and the snapping rule. Those are the parts that are
 * wrong by one silently.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCharMap,
  detectCaretApi,
  rangesFor,
  snapSpan,
  spanIndexOfEvent,
  stampSpanIndexes,
} from '@/components/hanzi/use-span-select';
import { hasCjk } from '@/lib/dict/rank';

/** A passage shaped like `<HanziText>`'s output: ruby for words, plain for the rest. */
function passage(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = [
    '<span data-testid="reader-token" data-token-index="0">',
    '<ruby data-char-index="0">打<rp>(</rp><rt>dǎ</rt><rp>)</rp></ruby>',
    '<ruby data-char-index="1">算<rp>(</rp><rt>suàn</rt><rp>)</rp></ruby>',
    '</span>',
    '<span data-testid="reader-text-run">，</span>',
    '<span data-testid="reader-token" data-token-index="2">',
    '<ruby data-char-index="0">明<rp>(</rp><rt>míng</rt><rp>)</rp></ruby>',
    '<ruby data-char-index="1">天<rp>(</rp><rt>tiān</rt><rp>)</rp></ruby>',
    '</span>',
  ].join('');
  document.body.append(root);
  return root;
}

describe('buildCharMap', () => {
  it('is the base text, with every reading excluded', () => {
    const map = buildCharMap(passage());
    // Not `打dǎ算suàn，明míng天tiān`, which is what `textContent` gives.
    expect(map.text).toBe('打算，明天');
  });

  it('indexes the punctuation between two words, because a span may cross it', () => {
    const map = buildCharMap(passage());
    expect(map.text[2]).toBe('，');
    // Its own piece, even though it carries no `data-char-index`: the whole
    // reason the stamp is derived from the map rather than from a running count
    // of character elements.
    expect(map.pieces.some((piece) => piece.start === 2)).toBe(true);
  });

  it('gives every character a piece, in reading order', () => {
    const map = buildCharMap(passage());
    expect(map.pieces.map((piece) => piece.start)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('rangesFor', () => {
  it('covers exactly the characters asked for, and never an <rt>', () => {
    const root = passage();
    const map = buildCharMap(root);
    const ranges = rangesFor(map, 1, 3);
    expect(ranges.map((range) => range.toString()).join('')).toBe('算，明');
    for (const range of ranges) {
      const parent = range.startContainer.parentElement;
      expect(parent?.tagName).not.toBe('RT');
      expect(parent?.tagName).not.toBe('RP');
    }
  });

  it('is the same span dragged backwards', () => {
    const map = buildCharMap(passage());
    expect(rangesFor(map, 3, 1).map((r) => r.toString()).join('')).toBe('算，明');
  });

  it('clips at the ends rather than throwing', () => {
    const map = buildCharMap(passage());
    expect(rangesFor(map, -5, 99).map((r) => r.toString()).join('')).toBe('打算，明天');
  });
});

describe('stampSpanIndexes', () => {
  it('stamps the passage-wide index, not the index inside the run', () => {
    const root = passage();
    stampSpanIndexes(root, buildCharMap(root));
    const stamped = [...root.querySelectorAll('[data-span-index]')].map(
      (node) => (node as HTMLElement).dataset.spanIndex,
    );
    // 明 is character 3 of the passage and character 0 of its own word. The
    // second number is what a running count of elements would have produced,
    // and it drifts at the first comma.
    expect(stamped).toEqual(['0', '1', '3', '4']);
  });

  it('is what spanIndexOfEvent reads back, from anywhere inside a character', () => {
    const root = passage();
    stampSpanIndexes(root, buildCharMap(root));
    const rt = root.querySelectorAll('rt')[3];
    // Even a tap on the pinyin band resolves up to its `<ruby>` — which is the
    // degrade's whole hit-test, and why it never dies on the `<rt>`.
    expect(spanIndexOfEvent(rt)).toBe(4);
    expect(spanIndexOfEvent(null)).toBeUndefined();
    expect(spanIndexOfEvent(document.body)).toBeUndefined();
  });
});

describe('snapSpan', () => {
  const text = '打算，明天。';

  it('leaves a span between two Chinese characters alone', () => {
    expect(snapSpan(text, 0, 4, hasCjk)).toMatchObject({ from: 0, to: 4, text: '打算，明天' });
  });

  it('pulls an endpoint on punctuation inward, and keeps the interior', () => {
    // Started on the comma, ended on the full stop: both ends move in, the
    // comma in the middle stays, because a span that crosses it contains it.
    expect(snapSpan(text, 2, 5, hasCjk)).toMatchObject({ from: 3, to: 4, text: '明天' });
    expect(snapSpan(text, 1, 2, hasCjk)).toMatchObject({ from: 1, to: 1, text: '算' });
  });

  it('refuses a span with no Chinese character in it at all', () => {
    expect(snapSpan('，。！', 0, 2, hasCjk)).toBeNull();
    expect(snapSpan(text, 5, 5, hasCjk)).toBeNull();
  });

  it('orders a backwards drag and clamps a stale index', () => {
    expect(snapSpan(text, 4, 0, hasCjk)).toMatchObject({ from: 0, to: 4 });
    expect(snapSpan(text, -3, 99, hasCjk)).toMatchObject({ from: 0, to: 4 });
  });
});

describe('detectCaretApi', () => {
  it('reports what the engine offers rather than assuming one', () => {
    expect(detectCaretApi({ caretPositionFromPoint: () => null } as unknown as Document)).toBe(
      'caretPositionFromPoint',
    );
    expect(detectCaretApi({ caretRangeFromPoint: () => null } as unknown as Document)).toBe(
      'caretRangeFromPoint',
    );
    // The case the whole degrade exists for. It has to be reachable, which is
    // what a required-member type on `Document` would have made impossible.
    expect(detectCaretApi({} as unknown as Document)).toBe('none');
  });
});
