/**
 * The dispatcher (docs/plans/web.md W8).
 *
 * `registry.test.ts` checks the table; this checks what happens when a key is
 * pressed, which is where W8's rule 1 lives and where the bugs this phase
 * exists to prevent actually happen:
 *
 * - a single-key binding firing while somebody types 中 into the lookup box;
 * - a binding firing on a keystroke that is part of an IME composition — the
 *   one this app is most exposed to, because the lookup box is where pinyin is
 *   typed into a Chinese IME;
 * - a component remounting and its binding then firing twice.
 *
 * The scope-shadowing case uses a synthetic table on purpose: the shipped one
 * has no cross-scope duplicate (and `registry.test.ts` keeps it that way), so
 * the rule that decides one has to be exercised against data that has one.
 */
import { useState } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  focusOwnsKey,
  isTextEntry,
  resolveBinding,
  resetShortcutsForTests,
  useShortcuts,
  type LiveScope,
} from '@/src/keys/use-shortcuts';
import { parseCombo } from '@/src/keys/registry';
import type { Binding, ShortcutScope } from '@/src/keys/registry';

import { act, render, screen } from '../render';

afterEach(() => {
  resetShortcutsForTests();
});

function press(target: EventTarget, init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** A live `app` scope whose handlers are all spies. */
function live(scope: LiveScope['scope'], handlers: Record<string, () => void>): LiveScope {
  return { scope, handlers: () => handlers };
}

describe('isTextEntry', () => {
  it('counts every text-ish input, including the lookup box', () => {
    const search = document.createElement('input');
    search.type = 'search';
    expect(isTextEntry(search)).toBe(true);

    const text = document.createElement('input');
    expect(isTextEntry(text)).toBe(true);

    const area = document.createElement('textarea');
    expect(isTextEntry(area)).toBe(true);
  });

  it('does not count a checkbox, a button or the document body', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(document.body)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it('counts a contenteditable element', () => {
    const div = document.createElement('div');
    // jsdom does not implement the `contenteditable` attribute's effect on the
    // property, so this is the property the code actually reads.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTextEntry(div)).toBe(true);
  });
});

describe('resolveBinding — W8 rule 1', () => {
  it('fires an unmodified binding when focus is not in a text box', () => {
    const event = press(document.body, { key: '/' });
    const resolved = resolveBinding(event, [live('app', { 'lookup.focus': () => undefined })]);
    expect(resolved?.binding.id).toBe('lookup.focus');
    expect(resolved?.handler).toBeTypeOf('function');
  });

  it('does NOT fire an unmodified binding while focus is in a text box', () => {
    const input = document.createElement('input');
    input.type = 'search';
    document.body.append(input);
    const event = press(input, { key: '/' });
    expect(resolveBinding(event, [live('app', { 'lookup.focus': () => undefined })])).toBeUndefined();
    input.remove();
  });

  it('…but a modified binding fires from inside the box, which is what Mod+K is for', () => {
    const input = document.createElement('input');
    input.type = 'search';
    document.body.append(input);
    const event = press(input, { key: 'k', metaKey: true });
    expect(resolveBinding(event, [live('app', { 'lookup.focus': () => undefined })])?.binding.id).toBe(
      'lookup.focus',
    );
    const control = press(input, { key: 'k', ctrlKey: true });
    expect(resolveBinding(control, [live('app', { 'lookup.focus': () => undefined })])?.binding.id).toBe(
      'lookup.focus',
    );
    input.remove();
  });

  it('ignores a bare key that carries a modifier the binding does not declare', () => {
    const event = press(document.body, { key: '/', metaKey: true });
    expect(resolveBinding(event, [live('app', {})])).toBeUndefined();
  });
});

describe('focusOwnsKey — the half the review found', () => {
  const enter = parseCombo('Enter');
  const space = parseCombo('Space');
  const slash = parseCombo('/');

  it('gives Enter and Space to a link, because that is how a keyboard presses one', () => {
    const link = document.createElement('a');
    link.href = '/practice';
    expect(focusOwnsKey(link, enter)).toBe(true);
    expect(focusOwnsKey(link, space)).toBe(true);
    // …and nothing else. `/` on a focused link is still a shortcut.
    expect(focusOwnsKey(link, slash)).toBe(false);
  });

  it('gives them to a button, a summary, a select and a role=button', () => {
    for (const tag of ['button', 'summary', 'select']) {
      expect(focusOwnsKey(document.createElement(tag), enter), tag).toBe(true);
    }
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    expect(focusOwnsKey(div, enter)).toBe(true);
  });

  it('does not give them to an anchor with no href, which is not a link', () => {
    expect(focusOwnsKey(document.createElement('a'), enter)).toBe(false);
  });

  it('gives a text box everything unmodified', () => {
    const box = document.createElement('input');
    expect(focusOwnsKey(box, slash)).toBe(true);
    expect(focusOwnsKey(box, enter)).toBe(true);
  });
});

describe('resolveBinding — Enter on a tab link while a card is face down', () => {
  it('leaves the link alone, so a keyboard user can still change tabs', () => {
    // The defect this closes: `review.reveal` binds Enter, the dispatcher
    // prevents the default of every firing binding, and so pressing Enter on
    // the Library tab flipped the card and stayed on Practice. A keyboard-only
    // learner could not leave the tab while a card was face down.
    const link = document.createElement('a');
    link.href = '/library';
    document.body.append(link);
    const event = press(link, { key: 'Enter' });
    expect(resolveBinding(event, [live('review', { 'review.reveal': () => undefined })])).toBeUndefined();
    link.remove();
  });

  it('…and Space on the same link is left alone too', () => {
    const link = document.createElement('a');
    link.href = '/library';
    document.body.append(link);
    const event = press(link, { key: ' ' });
    expect(resolveBinding(event, [live('review', { 'review.reveal': () => undefined })])).toBeUndefined();
    link.remove();
  });

  it('but a bare key the link does not own still fires', () => {
    const link = document.createElement('a');
    link.href = '/library';
    document.body.append(link);
    const event = press(link, { key: '/' });
    expect(resolveBinding(event, [live('app', { 'lookup.focus': () => undefined })])?.binding.id).toBe(
      'lookup.focus',
    );
    link.remove();
  });
});

describe('resolveBinding — a modal sheet is modal to the keyboard', () => {
  it('stops a review binding reaching the card behind the sheet', () => {
    // Reproduced by the adversarial review: with the shortcuts sheet open,
    // pressing 3 graded a card the learner could not see.
    const event = press(document.body, { key: '3' });
    expect(
      resolveBinding(event, [
        live('review', { 'review.grade.3': () => undefined }),
        live('dialog', {}),
      ]),
    ).toBeUndefined();
  });

  it('stops an app binding navigating out from under it', () => {
    // The other half: `/` navigated away and left the sheet mounted, scroll
    // locked, with its Escape handler on a panel focus had just left.
    const event = press(document.body, { key: '/' });
    expect(
      resolveBinding(event, [live('app', { 'lookup.focus': () => undefined }), live('dialog', {})]),
    ).toBeUndefined();
  });

  it('and lets everything through again once it is gone', () => {
    const event = press(document.body, { key: '/' });
    expect(resolveBinding(event, [live('app', { 'lookup.focus': () => undefined })])?.binding.id).toBe(
      'lookup.focus',
    );
  });
});

describe('resolveBinding — the IME', () => {
  it('fires nothing while a composition is in progress', () => {
    // A learner typing 出租车 through a pinyin IME produces keydowns whose
    // `key` is a Latin letter. Every one of them is a shortcut candidate.
    const event = press(document.body, { key: '1', isComposing: true });
    expect(resolveBinding(event, [live('review', { 'review.grade.1': () => undefined })])).toBeUndefined();
  });

  it('fires nothing for the legacy 229 spelling either', () => {
    const event = press(document.body, { key: '1', keyCode: 229 });
    expect(resolveBinding(event, [live('review', { 'review.grade.1': () => undefined })])).toBeUndefined();
  });
});

describe('resolveBinding — the rest of the rules', () => {
  it('leaves an event something else already handled alone', () => {
    const event = press(document.body, { key: '/' });
    event.preventDefault();
    expect(resolveBinding(event, [live('app', { 'lookup.focus': () => undefined })])).toBeUndefined();
  });

  it('matches a binding with no handler, and reports that there is nothing to run', () => {
    // `3` before the answer is revealed: the binding exists, the session has
    // nothing to do with it, and the key must reach the page untouched.
    const event = press(document.body, { key: '3' });
    const resolved = resolveBinding(event, [live('review', {})]);
    expect(resolved?.binding.id).toBe('review.grade.3');
    expect(resolved?.handler).toBeUndefined();
  });

  it('fires nothing at all when no scope is live', () => {
    expect(resolveBinding(press(document.body, { key: '1' }), [])).toBeUndefined();
  });

  it('lets the more specific live scope shadow the one under it', () => {
    const scopes: Record<string, ShortcutScope> = {
      low: { id: 'app', title: 'low', overridesFocusedElement: false, priority: 0 },
      high: { id: 'review', title: 'high', overridesFocusedElement: false, priority: 10 },
    };
    const bindings: Binding[] = [
      { id: 'low.enter', scope: 'app', keys: ['Enter'], description: 'low', source: 'plan' },
      { id: 'high.enter', scope: 'review', keys: ['Enter'], description: 'high', source: 'plan' },
    ];
    // The ids the synthetic scopes are keyed by have to be the ones the
    // bindings name, so the two tables line up the way the real ones do.
    const table = { app: scopes.low!, review: scopes.high! };
    const event = press(document.body, { key: 'Enter' });
    const resolved = resolveBinding(
      event,
      [live('app', { 'low.enter': () => undefined }), live('review', { 'high.enter': () => undefined })],
      bindings,
      table,
    );
    expect(resolved?.binding.id).toBe('high.enter');
  });

  it('honours a scope that says its bindings do fire while typing', () => {
    // No scope ships with this set. It is the seam W8b's palette plugs into —
    // its own input owns arrows, Enter and Escape by design — so the mechanism
    // is tested here rather than being discovered to be broken later.
    const table = {
      app: { id: 'app', title: 'palette-like', overridesFocusedElement: true, priority: 0 } as ShortcutScope,
    };
    const bindings: Binding[] = [
      { id: 'p.down', scope: 'app', keys: ['ArrowDown'], description: 'next row', source: 'plan' },
    ];
    const input = document.createElement('input');
    document.body.append(input);
    const event = press(input, { key: 'ArrowDown' });
    expect(
      resolveBinding(event, [live('app', { 'p.down': () => undefined })], bindings, table)?.binding.id,
    ).toBe('p.down');
    input.remove();
  });
});

function Session({ onReveal }: { onReveal: () => void }) {
  useShortcuts('review', { 'review.reveal': onReveal });
  return null;
}

describe('useShortcuts', () => {
  it('fires the handler and takes the key', () => {
    const onReveal = vi.fn();
    render(<Session onReveal={onReveal} />);
    const event = press(window, { key: ' ' });
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('stops firing once the component unmounts', () => {
    const onReveal = vi.fn();
    const view = render(<Session onReveal={onReveal} />);
    view.unmount();
    press(window, { key: ' ' });
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('fires ONCE when two instances of one scope are mounted', () => {
    // A remount that has not finished tearing down, a screen rendered twice by
    // a layout mistake: with a plain `window.addEventListener` per component
    // this double-grades a card, silently.
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        <Session onReveal={first} />
        <Session onReveal={second} />
      </>,
    );
    press(window, { key: ' ' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reads the handler as it is now, not as it was when the effect ran', () => {
    function Counter() {
      const [count, setCount] = useState(0);
      useShortcuts('review', { 'review.reveal': () => setCount((value) => value + 1) });
      return <span data-testid="count">{count}</span>;
    }
    render(<Counter />);
    act(() => {
      press(window, { key: 'Enter' });
    });
    act(() => {
      press(window, { key: 'Enter' });
    });
    expect(screen.getByTestId('count')).toHaveTextContent('2');
  });

  it('leaves the window with no listener once every scope is gone', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<Session onReveal={() => undefined} />);
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function));
    view.unmount();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    add.mockRestore();
    remove.mockRestore();
  });
});
