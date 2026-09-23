/**
 * Punctuation glued to its word (the first-run audit's "found, not fixed" item
 * 2): `lib/hanzi/glue.ts`, and the wrapper `<HanziText>` renders with it.
 *
 * jsdom has no layout, so whether a line really keeps its comma is
 * `tests/e2e/core/reader-punctuation.spec.ts`'s job. This file holds the other
 * half, which is the half that could break C3 and C5b without anything
 * looking wrong: the wrapper must be **layout and nothing else**. The text is
 * the same text in the same order, every character gets the same span index,
 * a tap on the punctuation is still no tap at all, and the only focusable
 * things are still the words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import userEvent from '@testing-library/user-event';

import { HanziText, type HanziRun } from '@/components/hanzi/hanzi-text';
import {
  buildCharMap,
  indexFromPoint,
  spanIndexOfEvent,
  stampSpanIndexes,
} from '@/components/hanzi/use-span-select';
import { splitForGlue } from '@/lib/hanzi/glue';

import { render, screen } from '../render';

describe('splitForGlue', () => {
  it('glues leading closing marks to the word before', () => {
    expect(splitForGlue('，', true, true)).toEqual({ lead: '，', rest: '', trail: '' });
    expect(splitForGlue('。”', true, false)).toEqual({ lead: '。”', rest: '', trail: '' });
    expect(splitForGlue('……', true, true)).toEqual({ lead: '……', rest: '', trail: '' });
  });

  it('glues trailing opening marks to the word after', () => {
    expect(splitForGlue('「', true, true)).toEqual({ lead: '', rest: '', trail: '「' });
    expect(splitForGlue('：「', true, true)).toEqual({ lead: '：', rest: '', trail: '「' });
    expect(splitForGlue('」「', true, true)).toEqual({ lead: '」', rest: '', trail: '「' });
    expect(splitForGlue('。（', true, true)).toEqual({ lead: '。', rest: '', trail: '（' });
  });

  it('leaves whatever may break as ordinary text, in order', () => {
    expect(splitForGlue('，David，', true, true)).toEqual({
      lead: '，',
      rest: 'David，',
      trail: '',
    });
    expect(splitForGlue('。\n\n「', true, true)).toEqual({ lead: '。', rest: '\n\n', trail: '「' });
    // A space before the mark is a break the text itself allows.
    expect(splitForGlue(' ，', true, true)).toEqual({ lead: '', rest: ' ，', trail: '' });
  });

  it('glues nothing to a side with no word on it', () => {
    expect(splitForGlue('，', false, true)).toEqual({ lead: '', rest: '，', trail: '' });
    expect(splitForGlue('「', true, false)).toEqual({ lead: '', rest: '「', trail: '' });
    expect(splitForGlue('「', false, false)).toEqual({ lead: '', rest: '「', trail: '' });
  });

  it('never changes the text: the three pieces are always the run', () => {
    for (const text of ['，', '「', '：「', '」，「', 'abc', '。\n', '（', '！？」', '']) {
      for (const before of [true, false]) {
        for (const after of [true, false]) {
          const { lead, rest, trail } = splitForGlue(text, before, after);
          expect(lead + rest + trail).toBe(text);
        }
      }
    }
  });
});

/** 他说：「你好，我叫David。」好吗？ — the shapes the reader meets, as segmented runs. */
const RUNS: HanziRun[] = [
  { text: '他', pinyinNum: 'ta1' },
  { text: '说', pinyinNum: 'shuo1' },
  { text: '：「' },
  { text: '你好', pinyinNum: 'ni3 hao3' },
  { text: '，' },
  { text: '我', pinyinNum: 'wo3' },
  { text: '叫', pinyinNum: 'jiao4' },
  { text: 'David。」' },
  { text: '好吗', pinyinNum: 'hao3 ma5' },
  { text: '？' },
];
const TEXT = RUNS.map((run) => run.text).join('');

function renderPassage(interactive: boolean) {
  const onWord = vi.fn();
  const utils = render(
    <HanziText
      runs={RUNS}
      plainRunTestId="reader-text-run"
      wordTestId="reader-token"
      {...(interactive ? { onWord } : {})}
    />,
  );
  return { ...utils, onWord, root: screen.getByTestId('hanzi-text') };
}

describe('the wrapper is layout and nothing else', () => {
  it('wraps each word with exactly the marks that must stay with it', () => {
    const { root } = renderPassage(true);
    const groups = [...root.querySelectorAll('.hanzi-glue')].map(baseTextOf);
    // "：「" bridges 说 and 你好: one wrapper, the run kept whole so the two
    // marks stay in one text node and the engine can compress them.
    expect(groups).toEqual(['说：「你好，', '好吗？']);
  });

  it('keeps the words as the only groupings, and the text in order', () => {
    const { root } = renderPassage(true);
    expect(baseTextOf(root)).toBe(TEXT);
    expect(root.getAttribute('data-hanzi')).toBe(TEXT);
    expect(
      screen.getAllByTestId('reader-token').map((node) => node.getAttribute('data-token')),
    ).toEqual(['他', '说', '你好', '我', '叫', '好吗']);
    expect(screen.getAllByTestId('reader-text-run').map((node) => node.textContent)).toEqual([
      '：「',
      '，',
      'David。」',
      '？',
    ]);
  });

  it('carries no attribute a hook could find — no role, no tab stop, no data', () => {
    const { root } = renderPassage(true);
    for (const glue of root.querySelectorAll('.hanzi-glue')) {
      expect(glue.tagName).toBe('SPAN');
      expect([...glue.attributes].map((attr) => attr.name)).toEqual(['class']);
      // Words and punctuation only, and every run between two of its words is
      // punctuation the line may not break inside.
      expect(glue.querySelectorAll('[data-token-index]').length).toBeGreaterThan(0);
    }
  });

  it('gives the character map the same text and every character the same span index', () => {
    const { root } = renderPassage(true);
    const map = buildCharMap(root);
    expect(map.text).toBe(TEXT);
    stampSpanIndexes(root, map);
    // Each annotated character's stamp is its offset in the passage, computed
    // from the runs rather than from the DOM.
    const expected: number[] = [];
    let at = 0;
    for (const run of RUNS) {
      if (run.pinyinNum) for (let i = 0; i < run.text.length; i += 1) expected.push(at + i);
      at += run.text.length;
    }
    const stamped = [...root.querySelectorAll<HTMLElement>('[data-span-index]')].map((el) =>
      Number(el.dataset.spanIndex),
    );
    expect(stamped).toEqual(expected);
  });

  it('matches the non-interactive render character for character', () => {
    // The spans-not-buttons render has no wrapper at all, so it is the
    // reference for what the map and the stamps were before the glue existed.
    const first = renderPassage(true);
    const glued = first.root;
    const gluedMap = buildCharMap(glued);
    stampSpanIndexes(glued, gluedMap);
    const gluedStamps = [...glued.querySelectorAll<HTMLElement>('[data-span-index]')].map(
      (el) => `${el.textContent}@${el.dataset.spanIndex}`,
    );
    first.unmount();

    const plain = renderPassage(false).root;
    expect(plain.querySelectorAll('.hanzi-glue')).toHaveLength(0);
    const plainMap = buildCharMap(plain);
    stampSpanIndexes(plain, plainMap);
    expect(gluedMap.text).toBe(plainMap.text);
    expect(gluedStamps).toEqual(
      [...plain.querySelectorAll<HTMLElement>('[data-span-index]')].map(
        (el) => `${el.textContent}@${el.dataset.spanIndex}`,
      ),
    );
  });

  it('a tap on glued punctuation is still no tap, and the degrade cannot name it', async () => {
    const { root, onWord } = renderPassage(true);
    stampSpanIndexes(root, buildCharMap(root));
    const comma = screen
      .getAllByTestId('reader-text-run')
      .find((node) => node.textContent === '，')!;
    expect(comma.closest('.hanzi-glue')).not.toBeNull();
    await userEvent.click(comma);
    expect(onWord).not.toHaveBeenCalled();
    expect(spanIndexOfEvent(comma)).toBeUndefined();
    expect(spanIndexOfEvent(comma, 'last')).toBeUndefined();

    // …while the word in the same wrapper answers exactly as it did.
    await userEvent.click(screen.getAllByTestId('reader-token')[2]!);
    expect(onWord).toHaveBeenCalledWith(3);
  });

  it('adds no focus stop: the focusable elements are the words, in order', () => {
    const { root } = renderPassage(true);
    const focusable = [...root.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]')];
    expect(focusable.map((el) => el.getAttribute('data-token'))).toEqual([
      '他',
      '说',
      '你好',
      '我',
      '叫',
      '好吗',
    ]);
  });
});

/**
 * A caret hit on an ELEMENT counts its children, and a drag past the end of a
 * line produces one on the line's last atomic box (review A, finding 1).
 *
 * Every line that ends a clause now ends in a `.hanzi-glue` inline-block, so
 * `caretPositionFromPoint` past the line end answers `{ glue, childNodes.length }`.
 * `indexOfNode` used to drop the offset and answer the element's FIRST
 * character, and the drag lost the rest of the last word: "…做什么？" came back
 * as "…做什" in Chromium.
 */
describe('a caret hit on an element honours its offset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function passage() {
    const root = document.createElement('div');
    root.innerHTML =
      '<button data-token-index="0"><ruby data-char-index="0">做<rt>zuò</rt></ruby></button>' +
      '<span class="hanzi-glue">' +
      '<button data-token-index="1"><ruby data-char-index="0">什<rt>shén</rt></ruby>' +
      '<ruby data-char-index="1">么<rt>me</rt></ruby></button><span>？</span></span>';
    document.body.append(root);
    // jsdom has no layout: every range is a zero box at the origin, so the point
    // below is never inside the character before a boundary.
    if (!Range.prototype.getBoundingClientRect) {
      Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    } else {
      vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0));
    }
    const glue = root.querySelector('.hanzi-glue')!;
    return { map: buildCharMap(root), glue };
  }

  function at(glue: Element, offset: number) {
    return {
      caretPositionFromPoint: () => ({ offsetNode: glue, offset }),
    } as unknown as Document;
  }

  it('past the last child is the element’s last character, not its first', () => {
    const { map, glue } = passage();
    expect(map.text).toBe('做什么？');
    expect(indexFromPoint(map, 500, 10, 'caretPositionFromPoint', at(glue, 2))).toBe(3);
  });

  it('before child k is the first character at or after it', () => {
    const { map, glue } = passage();
    expect(indexFromPoint(map, 500, 10, 'caretPositionFromPoint', at(glue, 0))).toBe(1);
    expect(indexFromPoint(map, 500, 10, 'caretPositionFromPoint', at(glue, 1))).toBe(3);
  });
});

/** The base text of an element: its text with the readings dropped. */
function baseTextOf(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll('rt, rp')) node.remove();
  return clone.textContent ?? '';
}
