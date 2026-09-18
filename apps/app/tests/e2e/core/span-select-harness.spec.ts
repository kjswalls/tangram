/**
 * The drag-select harness (docs/plans/core.md C5a).
 *
 * The riskiest UI in the project, measured before anything production is built.
 * Everything here runs in desktop Chromium, which is the whole reason C5a is a
 * phase of its own: `ios.md` I2 loads the same harness on a physical device to
 * answer STACK register #1, and no C5b production file may land before it does.
 *
 * Two of the criteria are **recorded, not asserted** — `pointermove` handler
 * time and dropped frames, and which caret API the feature detection chose.
 * They write into `test-results/c5a-record.json` and their numbers go into
 * `HANDOFF.md`, because no audit measured them and the first run is the
 * baseline the review judges.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const RECORD = 'test-results/c5a-record.json';
const record: Record<string, unknown> = {};

function write(): void {
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, JSON.stringify(record, null, 2));
}

interface Report {
  api: string;
  characters: number;
  highlights: boolean;
  moves: number[];
  droppedFrames: number;
  frames: number;
  span: { from: number; to: number } | null;
  text: string;
}

async function openHarness(page: Page): Promise<void> {
  await page.goto('/span-select');
  await expect(page.getByTestId('span-select-harness')).toBeVisible();
  // The passage is 500 characters; the map is built after it renders.
  await expect(page.locator('[data-span-index="0"]')).toBeAttached();
}

function report(page: Page): Promise<Report | undefined> {
  return page.evaluate(() => window.__spanSelect);
}

/** The centre of character `index`, in viewport coordinates. */
async function centreOf(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-span-index="${index}"]`).boundingBox();
  if (!box) throw new Error(`character ${index} has no box`);
  // The vertical centre of the CHARACTER, not of the ruby box above it: a
  // caret hit-test near the top of an annotated run lands in the `<rt>`.
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.75 };
}

/** A mouse drag from one character to another, a few steps at a time. */
async function drag(page: Page, from: number, to: number): Promise<void> {
  const a = await centreOf(page, from);
  const b = await centreOf(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(a.x + ((b.x - a.x) * step) / 8, a.y + ((b.y - a.y) * step) / 8);
  }
  await page.mouse.up();
}

test.describe('the harness itself', () => {
  test('loads standalone, with nothing else booted', async ({ page }) => {
    await openHarness(page);
    // `ios.md` I2 opens this URL on a device with no sign-in and no app state:
    // no shell, no nav, no dictionary banner.
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByTestId('dict-gate')).toHaveCount(0);
    await expect(page.getByTestId('span-passage')).toBeVisible();
  });

  test('the passage rests at touch-action: pan-y', async ({ page }) => {
    await openHarness(page);
    // The declaration the whole gesture design rests on. A static
    // `touch-action: none` here — which STACK §2.1's flattened wording implies
    // — would take vertical scrolling away from the browser on the one screen
    // made of a long scrolling passage.
    await expect(page.getByTestId('span-passage')).toHaveCSS('touch-action', 'pan-y');
  });

  test('RECORD: which caret API this engine offers', async ({ page }) => {
    await openHarness(page);
    /**
     * The report exists at load: the char-map effect writes it on mount,
     * precisely so `ios.md` I2 can read the instrument on a device before
     * touching anything. The comment here used to claim the opposite — and the
     * RECORD test below disproves it by reading `characters: 568` with no prior
     * interaction. The click stays because it exercises the clear path; it is
     * not what makes the report appear, and the `??` fallback it justified is
     * gone, because `seen` is always defined.
     */
    await page.getByTestId('span-clear').click();
    const seen = await report(page);
    const api = (await page.getByTestId('caret-api').textContent()) ?? '';
    record.caret = {
      note: 'feature detection, desktop Chromium (headless), as the harness reports it',
      label: api.trim(),
      api: seen?.api,
      customHighlightApi: await page.evaluate(() => 'highlights' in CSS),
    };
    write();
    // Recorded, not asserted — except that SOMETHING was detected, since a
    // recording of "none" on Chromium would mean the detection itself is broken.
    expect(api).not.toContain('none');
  });
});

test.describe('dragging a span', () => {
  test('selects exactly the characters dragged across, forwards', async ({ page }) => {
    await openHarness(page);
    await drag(page, 3, 7);
    expect((await report(page))?.span).toEqual({ from: 3, to: 7 });
  });

  test('…and backwards, to the same span', async ({ page }) => {
    await openHarness(page);
    await drag(page, 7, 3);
    expect((await report(page))?.span).toEqual({ from: 3, to: 7 });
  });

  test('…and under touch emulation', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await openHarness(page);
      const a = await centreOf(page, 3);
      const b = await centreOf(page, 7);
      await page.evaluate(
        async ({ a: from, b: to }) => {
          const passage = document.querySelector('[data-testid="span-passage"]')!;
          const fire = (type: string, x: number, y: number) =>
            passage.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 1,
                pointerType: 'touch',
                isPrimary: true,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
              }),
            );
          fire('pointerdown', from.x, from.y);
          for (let step = 1; step <= 8; step += 1) {
            fire('pointermove', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8);
          }
          fire('pointerup', to.x, to.y);
        },
        { a, b },
      );
      expect((await report(page))?.span).toEqual({ from: 3, to: 7 });
    } finally {
      await context.close();
    }
  });

  test('a span across a line break is contiguous in the SOURCE, not in visual order', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openHarness(page);

    // Find two characters on different visual lines.
    const pair = await page.evaluate(() => {
      const chars = [...document.querySelectorAll<HTMLElement>('[data-span-index]')];
      const first = chars[2];
      const firstTop = first.getBoundingClientRect().top;
      for (const candidate of chars.slice(3, 80)) {
        if (candidate.getBoundingClientRect().top > firstTop + 4) {
          return { from: 2, to: Number(candidate.dataset.spanIndex) };
        }
      }
      return null;
    });
    expect(pair, 'the passage did not wrap').not.toBeNull();

    await drag(page, pair!.from, pair!.to);
    const seen = await report(page);
    expect(seen?.span).toEqual({ from: pair!.from, to: pair!.to });
    // The characters are the source's, in order, across the break.
    expect([...(seen?.text ?? '')]).toHaveLength(pair!.to - pair!.from + 1);
  });

  test('the highlight never covers an <rt>', async ({ page }) => {
    await openHarness(page);
    await drag(page, 3, 12);

    const offenders = await page.evaluate((name) => {
      const registry = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights;
      const highlight = registry.get(name);
      if (!highlight) return ['no highlight registered'];
      const bad: string[] = [];
      let ranges = 0;
      for (const range of highlight) {
        ranges += 1;
        for (const node of [range.startContainer, range.endContainer]) {
          for (let el = node.parentElement; el; el = el.parentElement) {
            if (el.tagName === 'RT' || el.tagName === 'RP') {
              bad.push(`${el.tagName}: ${node.nodeValue ?? ''}`);
              break;
            }
          }
        }
      }
      if (ranges === 0) bad.push('the highlight is empty');
      return bad;
    }, 'span-select');
    expect(offenders).toEqual([]);

    // And the annotations really are there to have been swept up.
    expect(await page.getByTestId('span-passage').locator('rt').count()).toBeGreaterThan(50);
  });

  test('Copy writes the span’s base characters and no reading', async ({ browser }) => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    try {
      await openHarness(page);
      await drag(page, 3, 7);
      const expected = (await report(page))?.text ?? '';
      expect(expected).toHaveLength(5);

      await page.getByTestId('span-copy').click();
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toBe(expected);
      // No pinyin: every `<rt>` on screen is absent from what was copied.
      const readings = await page.getByTestId('span-passage').locator('rt').allTextContents();
      for (const reading of readings.slice(0, 40)) {
        if (reading.trim()) expect(clipboard).not.toContain(reading.trim());
      }
    } finally {
      await context.close();
    }
  });
});

test.describe('the gesture, and the page it sits on', () => {
  test('a near-vertical drag with a few pixels of drift does NOT select', async ({ page }) => {
    await openHarness(page);
    const a = await centreOf(page, 20);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    // 120px down, 6px across: drift, not a sweep.
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(a.x + (6 * step) / 8, a.y + (120 * step) / 8);
    }
    await page.mouse.up();
    expect((await report(page))?.span ?? null).toBeNull();
  });

  test('…and a horizontal drag of the same magnitude DOES', async ({ page }) => {
    await openHarness(page);
    const a = await centreOf(page, 20);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(a.x + (120 * step) / 8, a.y + (6 * step) / 8);
    }
    await page.mouse.up();
    expect((await report(page))?.span ?? null).not.toBeNull();
  });

  test('a vertical drag on the passage still scrolls the page', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await openHarness(page);
      // The passage must be taller than the viewport for this to mean anything.
      const scrollable = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      expect(scrollable).toBeGreaterThan(200);

      const a = await centreOf(page, 30);
      const cdp = await context.newCDPSession(page);
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
        cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x: a.x, y }],
        });
      await touch('touchStart', a.y);
      for (let step = 1; step <= 10; step += 1) await touch('touchMove', a.y - (200 * step) / 10);
      await touch('touchEnd', a.y - 200);

      await expect
        .poll(() => page.evaluate(() => window.scrollY), { timeout: 3_000 })
        .toBeGreaterThan(20);
      // …and it scrolled instead of selecting, which is the whole point of
      // resting at `pan-y` and taking the pointer only after the axis is known.
      expect((await report(page))?.span ?? null).toBeNull();
    } finally {
      await context.close();
    }
  });

  /**
   * **The instrument must not move the thing it measures.**
   *
   * The selected-text readout sits above the passage and grew with the
   * selection. Once the string wrapped, the passage below was pushed down a
   * line box *mid-drag*: the finger then landed on an earlier character, the
   * selection shrank, the readout shrank, the passage rose, and the span
   * oscillated — measured at 390px as jumps of 12–18 characters against a
   * uniform 32px per move, with runs of moves that committed nothing at all
   * because the shifted hit point fell into the `<rt>` band.
   *
   * No existing case could see it: every drag in this file stays under the wrap
   * threshold, and the RECORD drag runs at 1280px where the readout holds ~89
   * characters on one line. This one drags far enough at 390px to wrap several
   * times over, and asserts on the geometry rather than on the span, because
   * the span is the symptom.
   */
  test('the readout never reflows the passage mid-drag, however long the span', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await openHarness(page);
      const top = () =>
        page.evaluate(
          () =>
            (document.querySelector('[data-testid="span-passage"]') as HTMLElement).getBoundingClientRect()
              .top + window.scrollY,
        );

      const a = await centreOf(page, 2);
      const before = await top();
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      const seen: number[] = [];
      // Straight down five lines: at 390px the passage fits ~11 characters a
      // line, so this selects well past the point the readout used to wrap.
      for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(a.x + 40, a.y + step * 24);
        seen.push(await top());
      }
      await page.mouse.up();

      const selected = (await report(page))?.text ?? '';
      expect(selected.length, 'the drag must be long enough to have wrapped the readout').toBeGreaterThan(40);
      expect(new Set([before, ...seen, await top()]).size, `passage top moved: ${seen.join(',')}`).toBe(1);
    } finally {
      await context.close();
    }
  });

  /**
   * **A second finger must not leave the passage unable to scroll** — the
   * blocking finding of C5a's review, reproduced there with real touch through
   * CDP.
   *
   * `pointerdown` used to overwrite the gesture unconditionally, so a pinch or
   * a second thumb mid-drag orphaned the drag in flight: its moves were dropped
   * by the id guard, `dragging` was already false when a release arrived, and
   * the teardown that restores `touch-action: pan-y` never ran. The passage was
   * left at `none` for ever — on the one screen made of a long scrolling
   * passage — and not even Clear recovered it. This is C5a's "scrolling is not
   * broken" criterion, broken permanently by a routine gesture, in the code
   * `C5b` promotes.
   */
  test('a second pointer during a drag never leaves the passage unable to scroll', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await openHarness(page);
      const passage = page.getByTestId('span-passage');
      const a = await centreOf(page, 30);
      const cdp = await context.newCDPSession(page);
      const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ ...p })) });

      // A real horizontal drag…
      await send('touchStart', [a]);
      for (let step = 1; step <= 4; step += 1) await send('touchMove', [{ x: a.x + step * 12, y: a.y }]);
      // …interrupted by a second finger. A new touch point arrives as a
      // `touchStart` carrying BOTH points — which is what produces the second
      // `pointerdown` the harness has to ignore.
      await send('touchStart', [
        { x: a.x + 48, y: a.y },
        { x: a.x + 120, y: a.y + 60 },
      ]);
      await send('touchMove', [
        { x: a.x + 52, y: a.y },
        { x: a.x + 130, y: a.y + 70 },
      ]);
      await send('touchEnd', []);

      // The declaration the whole gesture design rests on, restored.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (document.querySelector('[data-testid="span-passage"]') as HTMLElement).style
                .touchAction,
          ),
        )
        .toBe('pan-y');
      await expect(passage).toHaveCSS('touch-action', 'pan-y');

      // …and the passage really does scroll again, which is what the learner
      // would have lost. Asserting only the style would pass on a rule that had
      // stopped meaning anything.
      await page.evaluate(() => window.scrollTo(0, 0));
      const b = await centreOf(page, 30);
      await send('touchStart', [b]);
      for (let step = 1; step <= 10; step += 1) await send('touchMove', [{ x: b.x, y: b.y - (200 * step) / 10 }]);
      await send('touchEnd', []);
      await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 3_000 }).toBeGreaterThan(20);
    } finally {
      await context.close();
    }
  });

  /**
   * **The pinyin band.** An `<rt>` renders above its `<ruby>`'s box, and
   * `caretPositionFromPoint` answers with the `<rt>`'s own text node for a
   * point in it — measured at 390px as a ~13px band per line, sitting directly
   * over the pinyin, which is the most natural thing for a thumb to aim at.
   * That node is in no piece of the char map, so the anchor came back
   * `undefined` and, because the anchor was hit-tested exactly once, the whole
   * gesture went silently dead: no highlight, no span, Copy disabled.
   *
   * The spec's own `centreOf` helper had *found* this band and aimed 75% down
   * the glyph to dodge it. This case aims straight at it on purpose.
   */
  test('a press that lands on the pinyin above a character still selects', async ({ page }) => {
    await openHarness(page);
    /**
     * Discovered from the DOM rather than hardcoded: only a run the dictionary
     * has a reading for carries `<rt>`s, and only a tappable run carries
     * per-character `data-span-index` elements at all — index 24 is inside a
     * plain punctuation run and has no box. The test picks the first annotated
     * character on the same line as a later annotated one, so the sweep is
     * horizontal and both ends are nameable.
     */
    const pick = await page.evaluate(() => {
      const stamped = [...document.querySelectorAll<HTMLElement>('[data-span-index]')];
      for (const node of stamped) {
        const rt = node.querySelector('rt');
        if (!rt) continue;
        const box = node.getBoundingClientRect();
        const band = rt.getBoundingClientRect();
        // A later character on the same visual line, far enough to be a sweep.
        const end = stamped.find((other) => {
          const rect = other.getBoundingClientRect();
          return Math.abs(rect.top - box.top) < 2 && rect.x - box.x > 40;
        });
        if (!end) continue;
        const endBox = end.getBoundingClientRect();
        return {
          from: Number(node.dataset.spanIndex),
          to: Number(end.dataset.spanIndex),
          press: { x: band.x + band.width / 2, y: band.y + band.height / 2 },
          release: { x: endBox.x + endBox.width / 2, y: endBox.y + endBox.height * 0.75 },
          /**
           * The press really does land outside every base character, which is
           * what makes this case the case it says it is.
           *
           * **It used to read `band.bottom <= box.top + 2` and `web.md` W6
           * turned that false**, correctly. Until W6 nothing was self-hosted and
           * `.hanzi` resolved to whatever CJK face the container had; Noto Serif
           * SC's own ascent and descent are taller, so a `<ruby>`'s border box
           * is now taller than the glyph ink inside it and the annotation box's
           * lower edge sits ~7px inside it at 24px. Screenshotted: the pinyin
           * still clears the hanzi with room to spare, and Blink lays a ruby
           * annotation out over the base's *font* box by design. So the
           * precondition asserts the thing this test needs — the pointer starts
           * above the character — rather than a metric of the face that
           * happened to be installed.
           */
          aboveGlyph: band.y + band.height / 2 < box.top,
        };
      }
      return null;
    });
    expect(pick, 'the passage has an annotated character with a later one on its line').not.toBeNull();
    expect(pick!.aboveGlyph, 'the press point is above the base character\u2019s box').toBe(true);

    await page.mouse.move(pick!.press.x, pick!.press.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(
        pick!.press.x + ((pick!.release.x - pick!.press.x) * step) / 8,
        pick!.press.y + ((pick!.release.y - pick!.press.y) * step) / 8,
      );
    }
    await page.mouse.up();

    const span = (await report(page))?.span;
    expect(span, 'a press on the pinyin selects rather than doing nothing').not.toBeNull();
    // It anchors on the character the pinyin belongs to, not on a neighbour.
    expect(span!.from).toBe(pick!.from);
    expect(span!.to).toBe(pick!.to);
  });

  test('RECORD: pointermove handler time and dropped frames over 500 characters', async ({
    page,
  }) => {
    await openHarness(page);
    // The passage's length in BASE CHARACTERS, not in elements: punctuation
    // renders as a plain run with no per-character element, so counting
    // elements counts something else.
    const characters = (await report(page))?.characters ?? 0;
    expect(characters).toBeGreaterThanOrEqual(500);

    // A full-width drag: press at the start of a line and sweep to the end.
    const a = await centreOf(page, 5);
    const b = await centreOf(page, 5);
    const width = await page.evaluate(
      () => document.querySelector('[data-testid="span-passage"]')!.getBoundingClientRect().width,
    );
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let step = 1; step <= 60; step += 1) {
      await page.mouse.move(a.x + ((width - 20) * step) / 60, b.y);
    }
    await page.mouse.up();

    const seen = await report(page);
    const moves = [...(seen?.moves ?? [])].sort((x, y) => x - y);
    const at = (q: number) => (moves.length ? moves[Math.min(moves.length - 1, Math.floor(moves.length * q))] : 0);
    record.pointermove = {
      note: 'desktop Chromium, headless; one sample per pointermove, whole handler including the highlight update',
      characters,
      samples: moves.length,
      p50Ms: Math.round(at(0.5) * 100) / 100,
      p95Ms: Math.round(at(0.95) * 100) / 100,
      maxMs: Math.round((moves.at(-1) ?? 0) * 100) / 100,
      frames: seen?.frames ?? 0,
      droppedFrames: seen?.droppedFrames ?? 0,
      budgetMs: 16.7,
    };
    write();
    // Recorded, not asserted — the budget is one frame and the review judges
    // the number. What is asserted is that the drag happened at all.
    expect(moves.length).toBeGreaterThan(10);
  });
});

/**
 * **The painting degrade, for an engine with no CSS Custom Highlight API.**
 *
 * core.md C5a specifies a fallback that "needs no `caretRangeFromPoint`, no
 * Custom Highlight API and no `pointermove` at all, and paints with a class on
 * the already-per-character DOM". The first draft degraded only on the caret
 * APIs: `paint()` returned early when the highlight registry was missing and
 * nothing else painted, so below Chrome 105 / Safari 17.2 the harness selected
 * **invisibly** — span computed, Copy enabled, nothing on screen. `ios.md` I2
 * is where that would have been discovered, on the one run that cannot be
 * repeated cheaply.
 */
test.describe('with no CSS Custom Highlight API', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // Feature detection is `'highlights' in CSS`, at runtime.
      // @ts-expect-error — removing an optional member is the point.
      delete CSS.highlights;
    });
  });

  test('paints the span with a class instead, rather than selecting invisibly', async ({ page }) => {
    await openHarness(page);
    await expect(page.getByTestId('highlight-api')).toHaveText('highlight: no');

    await drag(page, 3, 7);
    expect((await report(page))?.span).toEqual({ from: 3, to: 7 });

    // Something is painted, and it is the characters that were dragged across.
    const painted = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="span-passage"] .span-selected')].map((node) =>
        (node as HTMLElement).dataset.spanIndex ?? '',
      ),
    );
    expect(painted.length).toBeGreaterThan(0);
    expect(painted).toContain('3');
    expect(painted).toContain('7');
    // …and not a character outside the span.
    expect(painted).not.toContain('1');
    expect(painted).not.toContain('12');

    // The class carries a real colour, not just a name (`globals.css` keeps the
    // two paths on the same two tokens).
    const background = await page.evaluate(() => {
      const node = document.querySelector('.span-selected');
      return node ? getComputedStyle(node).backgroundColor : '';
    });
    expect(background).not.toBe('');
    expect(background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('never paints an <rt>, the same criterion the highlight path holds to', async ({ page }) => {
    await openHarness(page);
    await drag(page, 3, 12);
    const rts = await page.evaluate(
      () => document.querySelectorAll('[data-testid="span-passage"] rt.span-selected').length,
    );
    expect(rts).toBe(0);
    // …nor anything inside one.
    const inside = await page.evaluate(
      () => document.querySelectorAll('[data-testid="span-passage"] rt .span-selected').length,
    );
    expect(inside).toBe(0);
  });

  test('Clear unpaints it', async ({ page }) => {
    await openHarness(page);
    await drag(page, 3, 7);
    expect(await page.locator('.span-selected').count()).toBeGreaterThan(0);
    await page.getByTestId('span-clear').click();
    await expect(page.locator('.span-selected')).toHaveCount(0);
  });
});

test.describe('the fallback, with both caret APIs gone', () => {
  test.beforeEach(async ({ page }) => {
    // Feature detection is at runtime, so removing them before the app loads is
    // what a browser without them looks like.
    await page.addInitScript(() => {
      // @ts-expect-error — deleting an optional DOM member is the point.
      delete Document.prototype.caretPositionFromPoint;
      // @ts-expect-error — the WebKit-proprietary one too.
      delete Document.prototype.caretRangeFromPoint;
    });
  });

  test('engages automatically, and tap-then-tap-to-here gives the same span', async ({ page }) => {
    await openHarness(page);
    await expect(page.getByTestId('caret-api')).toHaveText('caret: none');

    await page.locator('[data-span-index="3"]').click();
    // The affordance C5a names, so the learner knows the gesture is armed.
    await expect(page.getByTestId('span-to-here')).toBeVisible();

    await page.locator('[data-span-index="7"]').click();
    expect((await report(page))?.span).toEqual({ from: 3, to: 7 });
    await expect(page.getByTestId('span-to-here')).toHaveCount(0);
  });

  test('and a drag does nothing, because there is nothing to hit-test with', async ({ page }) => {
    await openHarness(page);
    await drag(page, 3, 7);
    expect((await report(page))?.span ?? null).toBeNull();
  });
});
