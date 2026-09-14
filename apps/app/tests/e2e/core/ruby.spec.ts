/**
 * Per-character ruby, on a real passage (docs/plans/core.md C3).
 *
 * The four criteria C3 states about a *passage* live here, because outside the
 * reader — which C5b owns and this plan may not touch — nothing in the app
 * renders one. The gallery's `passage` section is that passage: 200 characters
 * at three `pinyinDisplay` settings, plus a 500-character one mounted on demand.
 *
 * Two of the four C3 asks to **record rather than assert**. Both write into
 * `test-results/c3-record.json` and their numbers are copied into `HANDOFF.md`:
 *
 *  - Whether Chromium's clipboard includes the `<rt>` text under
 *    `rt { user-select: none }`. AUDIT 1 sources that exclusion for **WebKit**
 *    (Safari 16.4, bug 80159) and no audit establishes Blink's. **It does
 *    exclude it** — the selection string carries the readings and the clipboard
 *    does not — so this one is recorded *and*, per C3's own instruction,
 *    promoted to an assertion in the same commit.
 *  - The layout time for a 500-character passage. Still recorded only: there is
 *    no budget to assert against, and a number from a headless container is not
 *    one to turn into a gate.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PHONE = { width: 390, height: 844 };
const RECORD = 'test-results/c3-record.json';

const record: Record<string, unknown> = {};

function write(): void {
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, JSON.stringify(record, null, 2));
}

/** Every `<rt>` under a passage, in DOM order. */
function readings(page: Page, mode: string) {
  return page.getByTestId(`passage-text-${mode}`).locator('rt');
}

test.describe('a passage of per-character ruby', () => {
  /**
   * `components/hanzi/ruby.css` exists and reaches the page.
   *
   * It is first because it was missing: the component shipped `.hanzi-band`
   * and `.hanzi-rt` for a stylesheet nobody had written, so the annotations
   * were unstyled, `user-select: none` was never applied — which would have
   * made the clipboard recording below a recording of nothing — and the first
   * line's readings overflowed the passage by 13px. Every class the component
   * names is asserted here, because a class that resolves to nothing is
   * invisible in every other test in this file.
   */
  test('the ruby stylesheet is live', async ({ page }) => {
    await page.goto('/gallery');
    const passage = page.getByTestId('passage-text-always');
    await expect(passage).toBeVisible();

    const styles = await passage.evaluate((node) => {
      const rt = node.querySelector('rt');
      const ruby = node.querySelector('ruby');
      const span = getComputedStyle(node as HTMLElement);
      const strut = getComputedStyle(node as HTMLElement, '::before');
      return {
        rt: rt ? getComputedStyle(rt) : null,
        rubyPosition: ruby ? getComputedStyle(ruby).rubyPosition : null,
        strutHeight: Number.parseFloat(strut.height),
        strutWidth: Number.parseFloat(strut.width),
        bandDisplay: span.display,
      };
    });
    expect(styles.rt?.userSelect).toBe('none');
    // Smaller than the character it annotates, and in the muted colour — both
    // are `ruby.css` and neither is a browser default.
    expect(Number.parseFloat(styles.rt?.fontSize ?? '0')).toBeLessThan(24);
    expect(styles.rt?.fontFamily).toContain('DM Sans');
    expect(styles.rubyPosition).toBe('over');
    /**
     * The band is a zero-width **strut**, and its two halves are both
     * asserted: it has height (or the first line's readings escape the block),
     * and the element stays `display: inline` (or the passage stops wrapping —
     * an inline-block of un-annotated `<ruby>` elements has no break
     * opportunities in Chromium, and the `'tap'` column became one 2546px box).
     */
    expect(styles.strutHeight).toBeGreaterThan(0);
    expect(styles.strutWidth).toBe(0);
    expect(styles.bandDisplay).toBe('inline');
  });

  test('wraps at 390px with nothing clipped and no sideways scroll', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/gallery');
    const passage = page.getByTestId('passage-text-always');
    await expect(passage).toBeVisible();

    // The passage is 200 characters, so this is the criterion's subject and not
    // a short line that would wrap anywhere.
    const hanzi = (await passage.getAttribute('data-hanzi')) ?? '';
    expect(hanzi.length).toBeGreaterThanOrEqual(200);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    /**
     * Every `<rt>` box inside its container's — and inside the **block** that
     * would clip or overlap it, which is the one that matters. A ruby
     * annotation is laid out above the first baseline, so before `ruby.css`
     * reserved the band the first line's readings sat 13px above the passage
     * and over whatever was printed there. Measured in one `evaluate` over the
     * live DOM rather than 200 `boundingBox()` round trips, with a 0.5px
     * tolerance, because a fractional device-pixel box is not a clipped one.
     */
    const escaped = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="passage-text-always"]');
      if (!container) return ['no container'];
      const block = container.closest('p');
      if (!block) return ['no block ancestor'];
      const box = block.getBoundingClientRect();
      const inner = container.getBoundingClientRect();
      const bad: string[] = [];
      /**
       * Measured against the BLOCK, because the block is what would clip or
       * overlap — the inline passage's own box is the union of its line boxes
       * and sits *inside* the space the band strut reserves. The guard against
       * measuring inside an over-large box is the next line: the block may not
       * be more than two lines taller than the text it holds, or "inside the
       * container" stops meaning anything.
       */
      const fontSize = Number.parseFloat(getComputedStyle(container).fontSize);
      if (box.top < inner.top - 2 * fontSize) {
        bad.push(`block is ${inner.top - box.top}px taller than the passage above it`);
      }
      for (const rt of container.querySelectorAll('rt')) {
        const r = rt.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5) {
          bad.push(`${rt.textContent ?? ''} horizontally: ${r.left}..${r.right} in ${box.left}..${box.right}`);
        }
        if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) {
          bad.push(`${rt.textContent ?? ''} vertically: ${r.top}..${r.bottom} in ${box.top}..${box.bottom}`);
        }
      }
      return bad;
    });
    expect(escaped).toEqual([]);

    // Not vacuous: the passage must actually have annotations to clip.
    expect(await readings(page, 'always').count()).toBeGreaterThan(100);
  });

  test("'never' renders no <rt> at all, and reserves no band", async ({ page }) => {
    await page.goto('/gallery');
    await expect(page.getByTestId('passage-text-never')).toBeVisible();
    await expect(readings(page, 'never')).toHaveCount(0);
    await expect(page.getByTestId('passage-text-never')).toHaveAttribute('data-band', 'none');
    // The same passage, same page: the difference is the setting and nothing else.
    await expect(page.getByTestId('passage-text-always')).toHaveAttribute('data-band', 'reserved');
  });

  test("'tap' reveals exactly the word tapped, and the passage does not move", async ({ page }) => {
    await page.goto('/gallery');
    const passage = page.getByTestId('passage-text-tap');
    await expect(passage).toBeVisible();

    // Nothing revealed on a fresh render — but the band IS already reserved,
    // which is what makes the reveal free. See the geometry assertion below
    // and HANDOFF.md for why this departs from C3's literal wording.
    await expect(readings(page, 'tap')).toHaveCount(0);
    await expect(passage).toHaveAttribute('data-band', 'reserved');

    /**
     * The measurement the criterion is actually about.
     *
     * The first version of this test captured the first word's `top` and then
     * never read it — the only positional assertion left was
     * `offset >= 0`, which cannot be negative under any layout the component
     * can produce. Making `.hanzi-band` unconditional, or making the reveal
     * re-render with a different wrap, passed it. What is compared here is the
     * geometry of the **whole block** and of a word the tap does not touch,
     * before and after, to the pixel.
     */
    const geometry = () =>
      passage.evaluate((node) => {
        const block = node.closest('p');
        const words = [...node.querySelectorAll('[data-token-index]')];
        const box = (block ?? node).getBoundingClientRect();
        const last = words.at(-1)?.getBoundingClientRect();
        const round = (n: number) => Math.round(n * 100) / 100;
        // Document coordinates, not viewport: clicking a word scrolls it into
        // view, and a scrolled page is not a moved passage.
        return {
          blockTop: round(box.top + window.scrollY),
          blockHeight: round(box.height),
          words: words.length,
          // A word at the far end of the passage: if the reveal reflowed the
          // wrap, this moves even when the block does not.
          lastTop: round((last?.top ?? 0) + window.scrollY),
          lastLeft: round((last?.left ?? 0) + window.scrollX),
        };
      });

    const before = await geometry();
    expect(before.words).toBeGreaterThan(10);

    const word = passage.locator('[data-token-index="1"]');
    const expected = ((await word.getAttribute('data-hanzi')) ?? (await word.innerText())).length;
    await word.click();

    // Exactly that word's characters, and nothing else in the passage.
    await expect(readings(page, 'tap')).toHaveCount(expected);
    await expect(word.locator('rt')).toHaveCount(expected);

    // A second tap neither duplicates nor clears.
    await word.click();
    await expect(readings(page, 'tap')).toHaveCount(expected);

    expect(await geometry()).toEqual(before);
    expect(await passage.getAttribute('data-hanzi')).toBe(
      await page.getByTestId('passage-text-always').getAttribute('data-hanzi'),
    );
  });

  test('the clipboard excludes the readings — recorded, and then asserted', async ({
    page,
    context,
  }) => {
    // The criterion is about the **clipboard**, not about
    // `getSelection().toString()`: WebKit's bug 80159 fix is in the
    // copied-text algorithm, which runs on copy and not on selection. Both are
    // recorded, because they can disagree and it is the clipboard that ends up
    // in the learner's notes.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/gallery');
    await expect(page.getByTestId('passage-text-always')).toBeVisible();

    const selection = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="passage-text-always"]');
      if (!container) return '';
      const range = document.createRange();
      range.selectNodeContents(container);
      const selected = window.getSelection();
      selected?.removeAllRanges();
      selected?.addRange(range);
      return selected?.toString() ?? '';
    });
    expect(selection.length).toBeGreaterThan(0);

    await page.keyboard.press('ControlOrMeta+C');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());

    const passage = page.getByTestId('passage-text-always');
    const hanzi = (await passage.getAttribute('data-hanzi')) ?? '';
    const firstReading = (await passage.locator('rt').first().textContent()) ?? '';
    const userSelect = await passage.evaluate((node) => {
      const rt = node.querySelector('rt');
      return rt ? getComputedStyle(rt).userSelect : null;
    });

    record.clipboard = {
      note: 'Range over the whole passage, then ControlOrMeta+C, read back through navigator.clipboard',
      rtUserSelect: userSelect,
      passageLength: hanzi.length,
      firstReading,
      selection: {
        length: selection.length,
        containsReadingText: firstReading.length > 0 && selection.includes(firstReading),
        sample: selection.slice(0, 60),
      },
      clipboard: {
        length: clipboard.length,
        containsReadingText: firstReading.length > 0 && clipboard.includes(firstReading),
        sample: clipboard.slice(0, 60),
      },
    };
    write();

    /**
     * **Promoted from recorded to asserted**, which is what C3 says to do "if
     * Chromium does exclude it". It does: the selection string carries the
     * readings (1042 characters) and the clipboard does not (284 — the hanzi
     * exactly). So Blink honours `user-select: none` in the copied-text
     * algorithm the same way WebKit has since Safari 16.4, and the behaviour
     * the CSS relies on is no longer sourced for one engine only.
     *
     * The selection assertion is the other half: it is what makes this a claim
     * about *copying* rather than a claim that nothing was selected.
     */
    expect(selection).toContain(firstReading);
    expect(clipboard).not.toContain(firstReading);
    expect(clipboard).toBe(hanzi);
  });

  test('RECORD: layout time for a 500-character passage', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/gallery');
    const show = page.getByTestId('passage-long-show');
    await expect(show).toBeVisible();

    const ms = await page.evaluate(async () => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="passage-long-show"]',
      );
      if (!button) return -1;
      const start = performance.now();
      button.click();
      // React commits, then the browser lays out. Reading a geometry property
      // forces the layout to have happened before the clock is read.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const node = document.querySelector('[data-testid="passage-text-long"]');
      void node?.getBoundingClientRect().height;
      return performance.now() - start;
    });
    expect(ms).toBeGreaterThan(0);

    const long = page.getByTestId('passage-text-long');
    await expect(long).toBeVisible();
    const chars = ((await long.getAttribute('data-hanzi')) ?? '').length;
    expect(chars).toBeGreaterThanOrEqual(500);
    const rt = await long.locator('rt').count();

    record.layout = {
      note: 'click → React commit → one rAF → forced layout read, desktop Chromium, headless',
      characters: chars,
      rubyAnnotations: rt,
      milliseconds: Math.round(ms * 10) / 10,
    };
    write();
  });
});
