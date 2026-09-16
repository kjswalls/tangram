/**
 * Hold to slow (docs/plans/core.md C6).
 *
 * The three things C6 asks a unit test to hold: a hold produces one utterance
 * per character at the slow rate, releasing mid-sequence cancels the remainder,
 * and a new tap during a sequence cancels the old one. Plus the two the phase
 * would otherwise ship on trust — that the lit character actually moves, and
 * that the slow mode has a trigger a keyboard can reach, because a long press
 * is not an accessible affordance on its own.
 *
 * The clock is faked only for the hold threshold. Everything downstream is the
 * hand-cranked `FakeProvider`, so what is asserted is the contract rather than
 * whatever a fake timer happened to do.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HanziText } from '@/components/hanzi/hanzi-text';
import { HOLD_MS, SpeakControl, codeUnitOffset } from '@/components/hanzi/speak-control';
import { SLOW_RATE } from '@/lib/tts/sequence';

import { FakeProvider } from './fake-provider';
import { act, fireEvent, render, screen, waitFor } from '../render';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

afterEach(() => {
  vi.useRealTimers();
});

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe('ready');
  });
}

/** Press and hold past the threshold, without releasing. */
function hold(): void {
  const button = screen.getByTestId('speak-button');
  fireEvent.pointerDown(button);
  act(() => {
    vi.advanceTimersByTime(HOLD_MS + 10);
  });
}

describe('holding the speaker', () => {
  it('reads the block one character at a time, at 0.6x', async () => {
    const provider = new FakeProvider();
    render(<SpeakControl text="打算明" provider={provider} />);
    await ready();

    vi.useFakeTimers();
    hold();
    await act(async () => provider.settleMicrotasks());
    expect(provider.spoken.map((u) => u.text)).toEqual(['打']);
    expect(provider.spoken[0].options.rate).toBe(SLOW_RATE);

    // Crank the engine through the block.
    for (let i = 0; i < 3; i += 1) {
      const id = provider.last.id;
      provider.start(id);
      provider.end(id);
      await act(async () => provider.settleMicrotasks());
    }
    expect(provider.spoken.map((u) => u.text)).toEqual(['打', '算', '明']);
  });

  it('releasing mid-sequence cancels the remainder and issues no further utterances', async () => {
    const provider = new FakeProvider();
    render(<SpeakControl text="打算明天" provider={provider} />);
    await ready();

    vi.useFakeTimers();
    hold();
    await act(async () => provider.settleMicrotasks());
    const id = provider.last.id;
    provider.start(id);
    provider.end(id);
    await act(async () => provider.settleMicrotasks());
    expect(provider.spoken).toHaveLength(2);

    fireEvent.pointerUp(screen.getByTestId('speak-button'));
    await act(async () => provider.settleMicrotasks());

    // The third and fourth characters were never queued.
    expect(provider.spoken.map((u) => u.text)).toEqual(['打', '算']);
  });

  it('a press shorter than the threshold is a tap: one utterance for the block', async () => {
    const provider = new FakeProvider();
    render(<SpeakControl text="打算明" provider={provider} />);
    await ready();

    vi.useFakeTimers();
    const button = screen.getByTestId('speak-button');
    fireEvent.pointerDown(button);
    act(() => {
      vi.advanceTimersByTime(HOLD_MS - 50);
    });
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    await act(async () => provider.settleMicrotasks());

    // ONE utterance, the whole block — product rule 3's first clause.
    expect(provider.spoken.map((u) => u.text)).toEqual(['打算明']);
  });

  it('the click that follows a hold is not a second play', async () => {
    /**
     * A press-and-hold fires `pointerdown`, `pointerup` **and** `click`, so
     * without the suppression the release started a block utterance on top of
     * the sequence it had just stopped: the slow reading followed instantly by
     * the fast one, every time.
     */
    const provider = new FakeProvider();
    render(<SpeakControl text="打算" provider={provider} />);
    await ready();

    vi.useFakeTimers();
    const button = screen.getByTestId('speak-button');
    hold();
    await act(async () => provider.settleMicrotasks());
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    await act(async () => provider.settleMicrotasks());

    expect(provider.spoken.map((u) => u.text)).toEqual(['打']);
  });

  it('a new tap during a sequence cancels the old one', async () => {
    const provider = new FakeProvider();
    render(<SpeakControl text="打算明" provider={provider} />);
    await ready();

    vi.useFakeTimers();
    hold();
    await act(async () => provider.settleMicrotasks());
    const first = provider.last;
    fireEvent.pointerUp(screen.getByTestId('speak-button'));
    await act(async () => provider.settleMicrotasks());

    vi.useRealTimers();
    const button = screen.getByTestId('speak-button');
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    await act(async () => provider.settleMicrotasks());

    expect(first.settled).toBe(true);
    expect(provider.spoken.at(-1)?.text).toBe('打算明');
  });
});

describe('the block speaker from the keyboard', () => {
  /**
   * C6's fifth criterion — "the block speaker is reachable and activatable by
   * keyboard" — **had no test at all**, which is how the bug below shipped: the
   * only keyboard case in this file pressed the *slow* control, and the e2e
   * Tabs past the speaker to reach it.
   */
  it('Enter on the focused speaker plays the block', async () => {
    const user = userEvent.setup();
    const provider = new FakeProvider();
    render(<SpeakControl text="打算" provider={provider} />);
    await ready();

    screen.getByTestId('speak-button').focus();
    await user.keyboard('{Enter}');
    await act(async () => provider.settleMicrotasks());
    expect(provider.spoken.map((u) => u.text)).toEqual(['打算']);
  });

  it('…and still does after a hold that ended off the button', async () => {
    /**
     * The defect this asserts against: a release *on* the button fires
     * `pointerup` then `click`, but a drag-off fires `pointerleave` and **no
     * click**. One flag served both, so the drag-off path left "swallow the
     * next click" set for ever — and Chromium focuses a button on mousedown, so
     * the very next Enter on the still-focused speaker was eaten and the
     * learner got silence. Reproduced in a real browser before the fix.
     */
    const user = userEvent.setup();
    const provider = new FakeProvider();
    render(<SpeakControl text="打算" provider={provider} />);
    await ready();

    vi.useFakeTimers();
    const button = screen.getByTestId('speak-button');
    hold();
    await act(async () => provider.settleMicrotasks());
    expect(provider.spoken.map((u) => u.text)).toEqual(['打']);

    // Drag off and release outside: leave, no up, no click.
    fireEvent.pointerLeave(button);
    await act(async () => provider.settleMicrotasks());

    vi.useRealTimers();
    button.focus();
    await user.keyboard('{Enter}');
    await act(async () => provider.settleMicrotasks());

    // The block, on the FIRST Enter.
    expect(provider.spoken.at(-1)?.text).toBe('打算');
  });

  it('a hold that ends ON the button still swallows its own click', async () => {
    // The other half, so the fix cannot be "clear the flag everywhere".
    const provider = new FakeProvider();
    render(<SpeakControl text="打算" provider={provider} />);
    await ready();

    vi.useFakeTimers();
    const button = screen.getByTestId('speak-button');
    hold();
    await act(async () => provider.settleMicrotasks());
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    await act(async () => provider.settleMicrotasks());

    expect(provider.spoken.map((u) => u.text)).toEqual(['打']);
  });
});

describe('the hold target', () => {
  it('takes the touch for the whole gesture', () => {
    /**
     * A thumb that drifts past the browser's touch slop during a three-second
     * hold hands the touch to the scroller, which fires `pointercancel` — the
     * reading stops mid-word and the page slides away. jsdom has no scrolling
     * and `page.mouse` never pans, so the class and the rule behind it are what
     * a test can hold.
     */
    const provider = new FakeProvider();
    render(<SpeakControl text="打算" provider={provider} />);
    expect(screen.getByTestId('speak-button').className).toContain('speak-hold');

    const css = readFileSync(resolve(APP_ROOT, 'app/globals.css'), 'utf8');
    // The RULE, not the first mention — the prose above it names the selector.
    const at = css.indexOf('.speak-hold {');
    expect(at, '.speak-hold has no rule in globals.css').toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toContain('touch-action: none');
    // …and the half that stops a long press summoning the iOS callout over the
    // card being read. Tailwind emits no utility for it.
    expect(rule).toContain('-webkit-touch-callout: none');
  });
});

describe('the lit character', () => {
  it('advances once per character, with supportsBoundary FALSE', async () => {
    // Two of the three engines cannot be relied on for boundaries, so the
    // highlight has to move without them — which is the case this asserts and
    // the one `lib/tts/sequence.ts` is built for.
    const provider = new FakeProvider({ supportsBoundary: false });
    render(
      <>
        <HanziText runs={[{ text: '打算明', pinyinNum: 'da3 suan4 ming2' }]} display="always" />
        <SpeakControl text="打算明" provider={provider} />
      </>,
    );
    await ready();

    /**
     * The base character, not `textContent`: the mark lands on the `<ruby>`, so
     * `textContent` interleaves the reading — `打(dǎ)`. That is correct for the
     * DOM (the character and its reading light together) and useless as a hook.
     */
    const lit = () =>
      [...document.querySelectorAll('[data-speaking="true"]')].map(
        (node) => node.firstChild?.textContent,
      );

    vi.useFakeTimers();
    hold();
    await act(async () => provider.settleMicrotasks());
    expect(lit()).toEqual([]);

    act(() => provider.start(provider.last.id));
    expect(lit()).toEqual(['打']);

    await act(async () => {
      provider.end(provider.last.id);
      await provider.settleMicrotasks();
    });
    act(() => provider.start(provider.last.id));
    expect(lit()).toEqual(['算']);

    // Releasing clears it: a character left lit for ever is the failure the
    // `onIndex(null)` contract exists to prevent.
    fireEvent.pointerUp(screen.getByTestId('speak-button'));
    await act(async () => provider.settleMicrotasks());
    expect(lit()).toEqual([]);
  });

  it('composes with the selected-span mark instead of fighting it', async () => {
    /**
     * C6 asks for the speaking mark and the span mark to compose. The span's
     * ring lands on the word grouping and the speaking class lands on the
     * character inside it, so both are present at once — which is what the
     * requirement is about, whatever mechanism paints each.
     */
    const provider = new FakeProvider();
    render(
      <>
        <HanziText
          runs={[{ text: '打算', pinyinNum: 'da3 suan4' }]}
          display="always"
          span={{ from: 0, to: 1 }}
        />
        <SpeakControl text="打算" provider={provider} />
      </>,
    );
    await ready();

    vi.useFakeTimers();
    hold();
    await act(async () => provider.settleMicrotasks());
    act(() => provider.start(provider.last.id));

    expect(document.querySelector('[data-in-span="true"]')).not.toBeNull();
    expect(document.querySelector('[data-speaking="true"]')?.firstChild?.textContent).toBe('打');
  });

  it('counts in code units, so an astral character does not shift everything after it', () => {
    // `lib/tts/sequence.ts` counts code points; the DOM counts code units.
    expect(codeUnitOffset('\u{20BB7}林', 0)).toBe(0);
    expect(codeUnitOffset('\u{20BB7}林', 1)).toBe(2);
    expect(codeUnitOffset('打算', 1)).toBe(1);
  });
});

describe('the non-gesture trigger', () => {
  it('is a real button, reachable and pressable from the keyboard', async () => {
    const user = userEvent.setup();
    const provider = new FakeProvider();
    render(<SpeakControl text="打算" provider={provider} />);
    await ready();

    const slow = screen.getByTestId('speak-slow');
    expect(slow.tagName).toBe('BUTTON');
    expect(slow.getAttribute('aria-pressed')).toBe('false');
    // A screen reader has to be able to say what it does.
    expect(slow.getAttribute('aria-label')).toContain('slowly');

    slow.focus();
    expect(document.activeElement).toBe(slow);
    await user.keyboard('{Enter}');
    await act(async () => provider.settleMicrotasks());

    // The same sequence the hold drives, not a second code path.
    expect(provider.spoken.map((u) => u.text)).toEqual(['打']);
    expect(provider.spoken[0].options.rate).toBe(SLOW_RATE);
    expect(screen.getByTestId('speak-slow').getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles off, because nothing can hold a key', async () => {
    const user = userEvent.setup();
    const provider = new FakeProvider();
    render(<SpeakControl text="打算明天" provider={provider} />);
    await ready();

    await user.click(screen.getByTestId('speak-slow'));
    await act(async () => provider.settleMicrotasks());
    expect(provider.spoken).toHaveLength(1);

    await user.click(screen.getByTestId('speak-slow'));
    await act(async () => provider.settleMicrotasks());
    expect(provider.spoken).toHaveLength(1);
    expect(screen.getByTestId('speak-slow').getAttribute('aria-pressed')).toBe('false');
  });

  it('is absent when there is no voice, like every other control here', async () => {
    const provider = new FakeProvider({ voiceless: true });
    render(<SpeakControl text="打算" provider={provider} />);
    await waitFor(() => {
      expect(screen.getByTestId('speak-button').getAttribute('data-tts-status')).toBe(
        'unavailable',
      );
    });
    // Offering a slow reading on a device that cannot read at all is the
    // "nothing happens" failure the visible reason exists to prevent.
    expect(screen.queryByTestId('speak-slow')).toBeNull();
  });
});

describe('tapping one character', () => {
  it('speaks exactly that character', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();

    render(
      <HanziText
        runs={[{ text: '打算', pinyinNum: 'da3 suan4' }]}
        display="always"
        speakOnTap
        speakProvider={provider}
      />,
    );
    await user.click(screen.getAllByTestId('hanzi-char')[1]);

    // 算, not 打算 — rule 3's third clause.
    expect(provider.spoken.map((u) => u.text)).toEqual(['算']);
    expect(provider.spoken[0].options.rate).toBe(SLOW_RATE);
  });

  it('does nothing where the caller answers a character tap itself', async () => {
    const provider = new FakeProvider();
    const user = userEvent.setup();
    const onCharacter = vi.fn();

    // The reader and the word sheet open the character SHEET, which has a
    // speaker of its own; talking over it would be the worse answer.
    render(
      <HanziText
        runs={[{ text: '打算', pinyinNum: 'da3 suan4' }]}
        display="always"
        speakOnTap
        speakProvider={provider}
        onCharacter={onCharacter}
      />,
    );
    await user.click(screen.getAllByTestId('hanzi-char')[1]);

    expect(onCharacter).toHaveBeenCalledWith(0, 1);
    expect(provider.spoken).toEqual([]);
  });
});
