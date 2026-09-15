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
  endOfCodePoint,
  rangesFor,
  snapSpan,
  spanIndexOfEvent,
  stampSpanIndexes,
  startOfCodePoint,
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


/**
 * A passage with an astral character in it (docs/plans/core.md C5b, second pass).
 *
 * 𠮷 is U+20BB7 — CJK Extension B, **two UTF-16 code units** — so `body[1]` is a
 * lone low surrogate. Three things used to conspire at that offset:
 * `caretPositionFromPoint` returns the boundary between the halves, a `Range`
 * over half a pair reports the whole glyph's box so the disambiguation accepted
 * it, and `lib/dict/rank.ts`'s `CJK_PATTERN` answers `true` for a lone
 * surrogate, so the endpoint snapping did not pull it back either. The span's
 * text then began with an unpaired surrogate: a dictionary miss, a mojibake
 * clipboard, and a card whose stored offset re-sliced the sentence mid-pair on
 * every review.
 */
const ASTRAL = '\u{20BB7}林，书';

describe('code-point alignment', () => {
  it('knows the lone surrogate is not a character', () => {
    expect([...ASTRAL]).toHaveLength(4);
    expect(ASTRAL.length).toBe(5);
    // The thing that made this reachable rather than theoretical.
    expect(hasCjk(ASTRAL[1])).toBe(true);
  });

  it('pulls an index inside a pair back to the pair’s start', () => {
    expect(startOfCodePoint(ASTRAL, 1)).toBe(0);
    expect(startOfCodePoint(ASTRAL, 0)).toBe(0);
    expect(startOfCodePoint(ASTRAL, 2)).toBe(2);
  });

  it('pushes an end index forward to the pair’s last unit', () => {
    expect(endOfCodePoint(ASTRAL, 0)).toBe(1);
    expect(endOfCodePoint(ASTRAL, 1)).toBe(1);
    expect(endOfCodePoint(ASTRAL, 2)).toBe(2);
  });

  it('snapSpan never returns half a character', () => {
    // A press on the right half of 𠮷, dragged to 林.
    const span = snapSpan(ASTRAL, 1, 2, hasCjk);
    expect(span).toMatchObject({ from: 0, to: 2, text: '\u{20BB7}林' });
    // …and the string it hands on is whole code points, not surrogate halves.
    expect([...(span?.text ?? '')]).toEqual(['\u{20BB7}', '林']);
  });

  it('…in either direction, and with the pair as the far end', () => {
    expect(snapSpan(ASTRAL, 2, 1, hasCjk)).toMatchObject({ from: 0, to: 2 });
    expect(snapSpan(ASTRAL, 2, 0, hasCjk)).toMatchObject({ from: 0, to: 2 });
    expect(snapSpan(ASTRAL, 0, 0, hasCjk)).toMatchObject({ from: 0, to: 1, text: '\u{20BB7}' });
  });

  it('snapping past a comma still lands on whole characters', () => {
    // Ends on the comma at 3 → pulls back onto 林, not onto half of 𠮷.
    expect(snapSpan(ASTRAL, 0, 3, hasCjk)).toMatchObject({ from: 0, to: 2 });
    // Starts on the comma at 3 → forward onto 书.
    expect(snapSpan(ASTRAL, 3, 4, hasCjk)).toMatchObject({ from: 4, to: 4, text: '书' });
  });
});

describe('stampSpanIndexes is linear', () => {
  /**
   * The first version `find`-ed a piece per element with `element.contains()`,
   * which is ~n²/2 containment tests — measured at 86 ms for 2,000 characters
   * and 359 ms for 4,000 in desktop Chromium, twice per passage, with the drag
   * dead the whole time. jsdom is slower than a browser, so the bound is
   * generous; it is there to fail loudly if the loop goes quadratic again, not
   * to police milliseconds.
   */
  it('stamps a 4,000-character passage without going quadratic', () => {
    const root = document.createElement('div');
    root.innerHTML = Array.from(
      { length: 4000 },
      (_, index) => `<ruby data-char-index="${index % 4}">字</ruby>`,
    ).join('');
    document.body.append(root);
    const map = buildCharMap(root);
    expect(map.text).toHaveLength(4000);

    const started = performance.now();
    stampSpanIndexes(root, map);
    const elapsed = performance.now() - started;

    const stamped = [...root.querySelectorAll('[data-span-index]')].map(
      (node) => (node as HTMLElement).dataset.spanIndex,
    );
    expect(stamped).toHaveLength(4000);
    expect(stamped[0]).toBe('0');
    expect(stamped[3999]).toBe('3999');
    expect(elapsed).toBeLessThan(2000);
    root.remove();
  });
});
