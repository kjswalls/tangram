/**
 * `<HanziText>` (docs/plans/core.md C3).
 *
 * The three things that are easy to get wrong and impossible to see:
 *
 * 1. **A fallback must render ONE annotation, never a per-character guess**, and
 *    an entry the dictionary has no reading for (`xx5`) must render **no** `<rt>`
 *    at all — an empty one reserves the band and teaches nothing.
 * 2. **`pinyinDisplay: 'never'` hides every reading EXCEPT on a card's answer
 *    face**, which is what `force` is.
 * 3. **`'tap'` reveals the tapped word and opens the sheet in one gesture**, and
 *    the passage does not reflow when it does — which is why, in `'tap'`, the
 *    band is reserved from the first render rather than by the first reveal.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import userEvent from '@testing-library/user-event';

import { HanziText, HanziWord } from '@/components/hanzi/hanzi-text';

import { render, screen } from '../render';

const DASUAN = { text: '打算', pinyinNum: 'da3 suan4' };
const MINGTIAN = { text: '明天', pinyinNum: 'ming2 tian1' };

function rtTexts(): string[] {
  return screen.queryAllByTestId('hanzi-rt').map((node) => node.textContent ?? '');
}

describe('rendering', () => {
  it('renders one ruby per character with its own syllable', () => {
    render(<HanziWord {...DASUAN} />);
    expect(screen.getAllByTestId('hanzi-char')).toHaveLength(2);
    expect(rtTexts()).toEqual(['dǎ', 'suàn']);
  });

  it('declares the language on the run, because Han unification needs it', () => {
    render(<HanziWord {...DASUAN} />);
    expect(screen.getByTestId('hanzi-text').getAttribute('lang')).toBe('zh-Hans');
  });

  it('a count mismatch renders ONE annotation over the whole run, not a guess', () => {
    render(<HanziWord text="打算去" pinyinNum="da3 suan4" />);
    expect(screen.getAllByTestId('hanzi-char')).toHaveLength(1);
    expect(rtTexts()).toEqual(['dǎsuàn']);
    expect(screen.getByTestId('hanzi-word').getAttribute('data-align')).toBe('fallback');
  });

  it('an entry the dictionary has no reading for renders NO rt at all', () => {
    render(<HanziWord text="々" pinyinNum="xx5" />);
    // Not an empty `<rt>`: that reserves the band and says nothing.
    expect(rtTexts()).toEqual([]);
    expect(screen.getByTestId('hanzi-text').getAttribute('data-band')).toBe('none');
  });

  it('a run with no reading at all renders plain, untappable, and with no test id by default', () => {
    const { container } = render(<HanziText runs={[{ text: '。' }]} />);
    expect(screen.queryAllByTestId('hanzi-word')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid]')).toHaveLength(1); // the wrapper only
    expect(container.textContent).toBe('。');
  });

  it('gives plain runs the caller’s test id when asked — the reader’s hook', () => {
    render(<HanziText runs={[{ text: '。' }]} plainRunTestId="reader-text-run" />);
    expect(screen.getByTestId('reader-text-run').textContent).toBe('。');
  });

  it('carries the word states on the grouping span, never per character', () => {
    render(
      <HanziText runs={[DASUAN, { text: '，' }, MINGTIAN]} states={['known', undefined, 'new']} />,
    );
    const tokens = screen.getAllByTestId('hanzi-word');
    expect(tokens.map((node) => node.getAttribute('data-state'))).toEqual(['known', 'new']);
    // A word has one state; a character inside it does not have its own.
    for (const ruby of screen.getAllByTestId('hanzi-char')) {
      expect(ruby.getAttribute('data-state')).toBeNull();
    }
  });
});

describe('pinyinDisplay', () => {
  it("'always' renders every reading", () => {
    render(<HanziWord {...DASUAN} display="always" />);
    expect(rtTexts()).toEqual(['dǎ', 'suàn']);
  });

  it("'never' renders none", () => {
    render(<HanziWord {...DASUAN} display="never" />);
    expect(rtTexts()).toEqual([]);
  });

  it("'never' is overridden by `force` — the card answer face the product never hides", () => {
    render(<HanziWord {...DASUAN} display="never" force />);
    expect(rtTexts()).toEqual(['dǎ', 'suàn']);
    expect(screen.getByTestId('hanzi-text').getAttribute('data-display')).toBe('forced');
  });

  it('defaults to always with no provider above it', () => {
    render(<HanziWord {...DASUAN} />);
    expect(screen.getByTestId('hanzi-text').getAttribute('data-display')).toBe('always');
  });
});

describe("'tap' — one gesture, two effects", () => {
  it('renders no reading until a word is tapped', () => {
    render(<HanziText runs={[DASUAN, MINGTIAN]} display="tap" onWord={() => undefined} />);
    expect(rtTexts()).toEqual([]);
    /**
     * …and the band IS reserved already, with nothing revealed, which is what
     * makes the reveal layout-shift-free.
     *
     * core.md C3 asks for two things that cannot both hold: "the ruby band is
     * **not** reserved" in the default state, and "no layout shift on reveal —
     * reserving the band changes the line box". Reserving it later *is* the
     * shift. The stated reason wins over the stated mechanism, and the
     * departure is in HANDOFF.md.
     */
    expect(screen.getByTestId('hanzi-text').getAttribute('data-band')).toBe('reserved');
  });

  it('reserves nothing in tap mode when there is nothing to reveal', () => {
    // A passage of `xx5` entries has no reading to show at any setting, so the
    // band would be empty — the same rule the `'always'` case follows.
    render(<HanziText runs={[{ text: '々', pinyinNum: 'xx5' }]} display="tap" />);
    expect(screen.getByTestId('hanzi-text').getAttribute('data-band')).toBe('none');
  });

  it("works with NO callback at all, which is every real call site", async () => {
    // The reveal lives in the delegated handler, and the handler used to be
    // attached only when a caller supplied `onWord` or `onCharacter`. The
    // gallery was the one call site that did — so `'tap'` behaved exactly like
    // `'never'` on every card, search result and list row in the app.
    const user = userEvent.setup();
    render(<HanziText runs={[DASUAN, MINGTIAN]} display="tap" />);
    expect(rtTexts()).toEqual([]);
    await user.click(screen.getAllByTestId('hanzi-word')[0]);
    expect(rtTexts()).toEqual(['dǎ', 'suàn']);
  });

  it('clears the reveals when the passage changes under the same instance', async () => {
    const user = userEvent.setup();
    const view = render(<HanziText runs={[DASUAN, MINGTIAN]} display="tap" />);
    await user.click(screen.getAllByTestId('hanzi-word')[1]);
    expect(rtTexts()).toEqual(['míng', 'tiān']);

    // Same component instance, new runs — a reader swapping texts, or a sheet
    // showing a second entry. Run 1 of the NEW passage must not come up
    // revealed because run 1 of the old one was tapped.
    view.rerender(
      <HanziText runs={[{ text: '学习', pinyinNum: 'xue2 xi2' }, DASUAN]} display="tap" />,
    );
    expect(rtTexts()).toEqual([]);
  });

  it('reveals exactly the tapped word, and tells the caller to open the sheet', async () => {
    const onWord = vi.fn();
    const user = userEvent.setup();
    render(<HanziText runs={[DASUAN, MINGTIAN]} display="tap" onWord={onWord} />);

    await user.click(screen.getAllByTestId('hanzi-word')[0]);

    // One gesture: the reading appears AND the caller is told to open the sheet.
    expect(onWord).toHaveBeenCalledWith(0);
    expect(rtTexts()).toEqual(['dǎ', 'suàn']);
    // The rest of the passage is untouched.
    expect(screen.getAllByTestId('hanzi-word')[1].querySelectorAll('rt')).toHaveLength(0);
    expect(screen.getByTestId('hanzi-text').getAttribute('data-band')).toBe('reserved');
  });

  it('a second tap neither duplicates nor clears the reading', async () => {
    const onWord = vi.fn();
    const user = userEvent.setup();
    render(<HanziText runs={[DASUAN, MINGTIAN]} display="tap" onWord={onWord} />);

    const token = screen.getAllByTestId('hanzi-word')[0];
    await user.click(token);
    await user.click(token);

    expect(rtTexts()).toEqual(['dǎ', 'suàn']);
    expect(onWord).toHaveBeenCalledTimes(2);
  });

  it('reports the character as well as the word, so a second tap can open the character', async () => {
    const onWord = vi.fn();
    const onCharacter = vi.fn();
    const user = userEvent.setup();
    render(
      <HanziText runs={[DASUAN]} display="always" onWord={onWord} onCharacter={onCharacter} />,
    );

    await user.click(screen.getAllByTestId('hanzi-char')[1]);
    expect(onWord).toHaveBeenCalledWith(0);
    expect(onCharacter).toHaveBeenCalledWith(0, 1);
  });

  it('reports the right character inside a FALLBACK run, not always the first', async () => {
    /**
     * Fallback means the READING cannot be split, not that the characters
     * cannot be counted. The whole run used to carry one hardcoded
     * `data-char-index={0}`, so a tap anywhere in AA制 — or in any `xx5`
     * entry, or in any example-sentence or ask-panel token, all of which take
     * this branch — reported character 0, and C4's character sheet would have
     * opened on the wrong character with nothing to say it had.
     */
    const onCharacter = vi.fn();
    const user = userEvent.setup();
    render(
      <HanziText
        runs={[{ text: 'AA制', pinyinNum: 'AA zhi4' }]}
        display="always"
        onCharacter={onCharacter}
      />,
    );
    // One annotation over the whole run…
    expect(rtTexts()).toEqual(['AA zhì']);
    expect(screen.getByTestId('hanzi-word').getAttribute('data-align')).toBe('fallback');

    // …and three addressable characters under it.
    const chars = screen.getByTestId('hanzi-word').querySelectorAll('[data-char-index]');
    expect(chars).toHaveLength(3);
    await user.click(chars[2]);
    expect(onCharacter).toHaveBeenCalledWith(0, 2);
  });

  it('a tap on a plain run reports nothing', async () => {
    const onWord = vi.fn();
    const user = userEvent.setup();
    render(<HanziText runs={[{ text: '。' }]} display="always" onWord={onWord} />);
    await user.click(screen.getByText('。'));
    expect(onWord).not.toHaveBeenCalled();
  });
});

describe('one delegated handler', () => {
  /**
   * **Read from the source, because the DOM cannot answer this.**
   *
   * The rule is "the container keeps ONE delegated handler, because a pasted
   * passage is hundreds of characters and a handler per character is hundreds
   * of closures per recolour". The previous version of this test rendered a
   * passage and asserted every `<ruby>` had a null `onclick` **attribute** —
   * which is true of every React-rendered element ever, handler or not, since
   * React delegates from the root and never writes the content attribute. It
   * also rendered without `onWord` or `onCharacter`, so nothing was attached
   * in any case. Adding a per-character `onClick` to `<Ruby>` — the exact
   * regression named — left it green.
   *
   * There is no DOM-level way to count React handlers, so this reads the
   * module the way `tests/unit/ui/tokens.test.ts` reads `tokens.css`: there is
   * no CI, so the rule is a unit test or it is nothing (CLAUDE.md).
   */
  it('has exactly one onClick in the module, on the container', () => {
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const source = readFileSync(resolve(appRoot, 'components/hanzi/hanzi-text.tsx'), 'utf8');
    // Comments say `onClick` often enough to swamp the count.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const bindings = code.match(/\bonClick=/g) ?? [];
    expect(bindings).toHaveLength(1);
    // …and it is on the wrapper, next to the delegation comment's own marker.
    // C5b adds `spanSelect` to the condition — the two-tap degrade's closing
    // tap arrives at this handler and nowhere else — and C6 adds `speakOnTap`,
    // rule 3's "tap a character → hear that syllable alone". Both are
    // *conditions*; the handler is still the one on the container.
    expect(code).toContain(
      'onWord || onCharacter || revealsOnTap || spanSelect || speakOnTap ? onClick : undefined',
    );
    // The per-character components must not take one at all.
    expect(code).not.toMatch(/function Ruby\([^)]*onClick/);
  });

  it('still reports a character tapped deep inside a run, through that one handler', async () => {
    const user = userEvent.setup();
    const seen: [number, number][] = [];
    render(
      <HanziText
        runs={[DASUAN, MINGTIAN]}
        display="always"
        onCharacter={(run, char) => seen.push([run, char])}
      />,
    );
    // The second character of the second run: two levels of nesting below the
    // element the handler is actually on.
    const chars = screen.getAllByTestId('hanzi-char');
    await user.click(chars[3]);
    expect(seen).toEqual([[1, 1]]);
  });
});
