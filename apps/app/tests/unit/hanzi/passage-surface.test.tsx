/**
 * The two properties the C5b review found missing from the passage.
 *
 * Both were invisible to every gate: the production reader computed
 * `user-select: auto` while five comments in the same commit asserted the
 * opposite, and every word in the passage stopped being focusable while the
 * colouring specs — which read `data-state`, not roles — stayed green. There is
 * no CI in this repository, so each of them is a unit test or it is nothing
 * (CLAUDE.md).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render } from '../render';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { HanziText } from '@/components/hanzi/hanzi-text';
import type { SpanSelect } from '@/components/hanzi/use-span-select';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const RUNS = [
  { text: '打算', pinyinNum: 'da3 suan4' },
  { text: '，' },
  { text: '明天', pinyinNum: 'ming2 tian1' },
];

/** Just enough of the hook's handle to attach; no gesture is exercised here. */
function fakeSpanSelect(): SpanSelect {
  return {
    ref: () => undefined,
    handlers: {
      style: { touchAction: 'pan-y' },
      onPointerDown: () => undefined,
      onPointerMove: () => undefined,
      onPointerUp: () => undefined,
      onPointerCancel: () => undefined,
    },
    api: 'caretPositionFromPoint',
    highlights: true,
    anchor: null,
    dragging: { current: false },
    setAnchor: () => undefined,
    armFromTap: () => undefined,
    armsOnTap: false,
    toHere: () => undefined,
    textOf: () => '',
    characters: () => 0,
    clearPaint: () => undefined,
  };
}

describe('the passage a span is dragged over', () => {
  it('takes the select-none host class whenever a span handle is attached', () => {
    const { getByTestId, unmount } = render(
      <HanziText runs={RUNS} display="always" spanSelect={fakeSpanSelect()} />,
    );
    // The declaration lives in `app/globals.css`; what a component test can hold
    // is that the class reaches the container the gesture runs over — which is
    // the half that was missing, since the harness had it and the reader did not.
    expect(getByTestId('hanzi-text').className).toContain('hanzi-span-host');
    unmount();
  });

  it('…and does not put it on the thirty call sites that have no gesture', () => {
    const { getByTestId } = render(<HanziText runs={RUNS} display="always" />);
    // A card face and a search result are ordinary text; taking selection away
    // from them would be a regression of its own.
    expect(getByTestId('hanzi-text').className).not.toContain('hanzi-span-host');
  });

  it('the class actually suppresses selection and the iOS callout', () => {
    // `app/globals.css` is the authority; a class name that resolves to nothing
    // is exactly the shape of the defect this replaces (a stylesheet that did
    // not exist while every unit test passed).
    const css = readFileSync(resolve(appRoot, 'app/globals.css'), 'utf8');
    const rule = css.slice(css.indexOf('.hanzi-span-host'));
    expect(rule).toContain('.hanzi-span-host');
    expect(rule.slice(0, 200)).toContain('user-select: none');
    expect(rule.slice(0, 200)).toContain('-webkit-user-select: none');
    // The half Tailwind's `select-none` does not emit, and the half that stops
    // WebKit's edit-menu callout — the `UIEditMenuInteraction` path
    // `wave-zero.md` §10d rules out because this design does not use it.
    expect(rule.slice(0, 200)).toContain('-webkit-touch-callout: none');
  });
});

describe('a word the learner can act on is a control', () => {
  it('renders every word grouping as a real button when a tap means something', () => {
    const { getAllByTestId } = render(
      <HanziText runs={RUNS} display="always" onWord={() => undefined} />,
    );
    const words = getAllByTestId('hanzi-word');
    expect(words).toHaveLength(2);
    for (const word of words) {
      expect(word.tagName).toBe('BUTTON');
      expect(word.getAttribute('type')).toBe('button');
    }
  });

  it('Enter on a focused word opens it, which is what the deleted reader had', async () => {
    const user = userEvent.setup();
    const onWord = vi.fn();
    const { getAllByTestId } = render(
      <HanziText runs={RUNS} display="always" onWord={onWord} />,
    );
    const second = getAllByTestId('hanzi-word')[1];
    second.focus();
    expect(document.activeElement).toBe(second);
    await user.keyboard('{Enter}');
    // Index 2 in `runs`: the comma is run 1 and is not a word.
    expect(onWord).toHaveBeenCalledWith(2);
  });

  it('Tab reaches the words, so the passage is not pointer-only', async () => {
    const user = userEvent.setup();
    const { getAllByTestId } = render(
      <HanziText runs={RUNS} display="always" onWord={() => undefined} />,
    );
    const words = getAllByTestId('hanzi-word');
    await user.tab();
    expect(document.activeElement).toBe(words[0]);
    await user.tab();
    expect(document.activeElement).toBe(words[1]);
  });

  it('stays a plain span where nothing can be done with it', () => {
    const { getAllByTestId } = render(<HanziText runs={RUNS} display="always" />);
    // A card face has a `<HanziText>` too, and one tab stop per character run
    // on a screen with nothing to activate is noise for a keyboard user.
    for (const word of getAllByTestId('hanzi-word')) expect(word.tagName).toBe('SPAN');
  });
});
