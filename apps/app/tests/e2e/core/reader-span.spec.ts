/**
 * Drag to select a span, **in the reader** (docs/plans/core.md C5b).
 *
 * C5a proved the interaction against a harness; this proves the wiring. Every
 * assertion below is against `/read` with a real segmented passage, a real
 * reader store and the real word sheet — the things the harness deliberately
 * had none of.
 *
 * `wave-zero.md` §10d is why this file exists now rather than after a device
 * pass: the WKWebView crash register #1 rests on is fixed in iOS 26 beta 7,
 * does not reproduce under Xcode 26, and lives in `UIEditMenuInteraction` —
 * the native selection callout this design replaces. `ios.md` I2 survives as a
 * pre-TestFlight check.
 */
import { expect, test, type Page } from '@playwright/test';

import { DEMO_PARAGRAPH, readText, resetApp } from '../p5/helpers';
import { baseText } from '../hanzi';

/**
 * The demo paragraph's first characters, indexed.
 *
 *   我(0) 每(1) 天(2) 早(3) 上(4) 七(5) 点(6) 起(7) 床(8) ，(9) 先(10) 喝(11)
 *   一(12) 杯(13) 水(14) ，(15) 然(16) 后(17) 去(18) …
 *
 * Spelled out because every case below names character numbers, and a number
 * that has silently stopped meaning what it says is the failure this file is
 * least able to see.
 */
const CHARS = [...DEMO_PARAGRAPH];

function slice(from: number, to: number): string {
  return CHARS.slice(from, to + 1).join('');
}

async function openReader(page: Page, body: string = DEMO_PARAGRAPH): Promise<void> {
  await resetApp(page, { knownBand: 2, newPerDay: 0 });
  await readText(page, body);
  // The character map is built after the readings land and re-stamp the DOM;
  // until then a hit-test would index a passage that no longer exists.
  await expect(page.locator('[data-span-index="0"]')).toBeAttached();
  await expect(page.getByTestId('reader-text').locator('rt').first()).toBeAttached();
}

/**
 * The centre of character `index`, in viewport coordinates.
 *
 * Measured with a `Range` over the passage's own base text nodes rather than
 * from `[data-span-index]`, and that is not a stylistic choice: a run the
 * dictionary has no reading for — **every punctuation mark in the passage** —
 * renders as one plain `<span>` with no per-character elements, so it carries
 * no stamp and a selector-based helper cannot aim at a comma at all. Half the
 * cases below are about exactly what happens at a comma.
 */
async function centreOf(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page.evaluate((at) => {
    const root = document.querySelector('[data-testid="reader-text"]');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
          if (el.tagName === 'RT' || el.tagName === 'RP') return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue?.length ?? 0;
      if (at < seen + length) {
        const range = document.createRange();
        range.setStart(node, at - seen);
        range.setEnd(node, at - seen + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      seen += length;
    }
    return null;
  }, index);
  if (!box) throw new Error(`character ${index} has no box`);
  // The vertical centre of the CHARACTER, not of the ruby box above it: a caret
  // hit-test near the top of an annotated run lands in the `<rt>`.
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

/** The word groupings the ring is on — the coarse half of "what did I select". */
function ringed(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="reader-token"][data-in-span="true"]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-token') ?? ''),
  );
}

/** What the sheet is looking at, readings stripped. */
function sheetQuery(page: Page): Promise<string> {
  return baseText(page.getByTestId('reader-panel').getByTestId('lookup-panel').locator('h2'));
}

test.describe('dragging a span in the reader', () => {
  test('selects exactly the characters dragged across, and looks that span up', async ({
    page,
  }) => {
    await openReader(page);
    await drag(page, 3, 7);

    const span = slice(3, 7);
    expect(span).toBe('早上七点起');
    await expect.poll(() => sheetQuery(page)).toBe(span);
    // The ring follows the WHOLE span, not just its first word — the owner
    // confirmed this detail and C4 already got it right for a single tap.
    const marked = await ringed(page);
    expect(marked.length).toBeGreaterThan(1);
    expect(marked.join('')).toContain('早上');
  });

  test('…and backwards, to the same span', async ({ page }) => {
    await openReader(page);
    await drag(page, 7, 3);
    await expect.poll(() => sheetQuery(page)).toBe(slice(3, 7));
  });

  test('…and under touch emulation', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      await openReader(page);
      const a = await centreOf(page, 3);
      const b = await centreOf(page, 7);
      await page.evaluate(
        async ({ a: from, b: to }) => {
          const passage = document.querySelector('[data-testid="reader-text"]')!;
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
            fire(
              'pointermove',
              from.x + ((to.x - from.x) * step) / 8,
              from.y + ((to.y - from.y) * step) / 8,
            );
          }
          fire('pointerup', to.x, to.y);
        },
        { a, b },
      );
      await expect.poll(() => sheetQuery(page)).toBe(slice(3, 7));
    } finally {
      await context.close();
    }
  });

  test('a span that crosses punctuation contains it', async ({ page }) => {
    await openReader(page);
    // 起(7) … 先(10), across the comma at 9.
    await drag(page, 7, 10);
    expect(slice(7, 10)).toBe('起床，先');
    await expect.poll(() => sheetQuery(page)).toBe('起床，先');
  });

  test('a drag that starts or ends on punctuation snaps inward', async ({ page }) => {
    await openReader(page);
    // Starts on the comma at 9 → the span starts at 先(10).
    await drag(page, 9, 12);
    await expect.poll(() => sheetQuery(page)).toBe(slice(10, 12));

    // Ends on the comma at 9 → the span ends at 床(8).
    await drag(page, 7, 9);
    await expect.poll(() => sheetQuery(page)).toBe(slice(7, 8));
  });

  test('the passage carries per-character ruby, which is the surface rule 1 is about', async ({
    page,
  }) => {
    await openReader(page);
    const readings = await page
      .getByTestId('reader-text')
      .locator('rt')
      .filter({ hasNotText: '' })
      .count();
    expect(readings).toBeGreaterThan(50);
  });
});

test.describe('the clipboard, which the app owns here', () => {
  test('a copy with a span active writes exactly the span’s hanzi', async ({ browser }) => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    try {
      await openReader(page);
      await drag(page, 3, 7);
      await expect.poll(() => sheetQuery(page)).toBe(slice(3, 7));

      await page.keyboard.press('ControlOrMeta+c');
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(slice(3, 7));

      // No pinyin: every reading on screen is absent from what was copied.
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      const readings = await page.getByTestId('reader-text').locator('rt').allTextContents();
      for (const reading of readings.slice(0, 40)) {
        if (reading.trim()) expect(clipboard).not.toContain(reading.trim());
      }
    } finally {
      await context.close();
    }
  });

  test('a copy with NO span active writes nothing — user-select: none is doing its job', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    try {
      await openReader(page);
      // A sentinel, so "nothing" is distinguishable from "the empty string".
      await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
      await page.getByTestId('reader-text').click({ position: { x: 2, y: 2 }, force: true });
      await page.keyboard.press('ControlOrMeta+c');
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('SENTINEL');
    } finally {
      await context.close();
    }
  });

  test('the touch Copy affordance writes the same string', async ({ browser }) => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    try {
      await openReader(page);
      await drag(page, 3, 7);
      await expect.poll(() => sheetQuery(page)).toBe(slice(3, 7));
      await page.getByTestId('copy-span').click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(slice(3, 7));
    } finally {
      await context.close();
    }
  });
});

test.describe('the gesture, and the page it sits on', () => {
  test('a vertical drag on the passage still scrolls the page', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      // Three paragraphs: the criterion is only about a passage taller than the
      // viewport, and one demo paragraph fits on an 844px phone.
      await openReader(page, DEMO_PARAGRAPH.repeat(3));
      const scrollable = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      expect(scrollable, 'the passage must be taller than the viewport').toBeGreaterThan(200);

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
      // …and it scrolled instead of selecting: the passage rests at `pan-y` and
      // only takes the pointer once the axis is known.
      await expect(page.getByTestId('reader-panel')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a near-vertical drag with a few pixels of drift does NOT select', async ({ page }) => {
    await openReader(page);
    const a = await centreOf(page, 20);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(a.x + step, a.y + step * 6);
    }
    await page.mouse.up();
    await expect(page.getByTestId('reader-panel')).toHaveCount(0);
  });

  test('the highlight never covers an <rt>', async ({ page }) => {
    await openReader(page);
    await drag(page, 3, 12);

    const offenders = await page.evaluate(() => {
      const registry = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights;
      const highlight = registry.get('span-select');
      if (!highlight) return ['no highlight registered'];
      const bad: string[] = [];
      for (const range of highlight) {
        const parent = (range.startContainer as Node).parentElement;
        if (parent && (parent.tagName === 'RT' || parent.tagName === 'RP')) {
          bad.push(parent.textContent ?? '');
        }
      }
      return bad;
    });
    expect(offenders).toEqual([]);
  });
});

test.describe('the fallback, with both caret APIs gone', () => {
  /** Remove both caret APIs before any app script runs. */
  async function stub(page: Page): Promise<void> {
    await page.addInitScript(() => {
      // @ts-expect-error — deleting an optional DOM member is the point.
      delete Document.prototype.caretPositionFromPoint;
      // @ts-expect-error — the WebKit-proprietary one goes too.
      delete Document.prototype.caretRangeFromPoint;
    });
  }

  test('engages on the real reader, and tap-then-to-here gives the same span', async ({ page }) => {
    await stub(page);
    await openReader(page);

    // A tap still opens the word sheet — the reader's first tap is not the
    // degrade's arming tap, which is why the reader arms from a control.
    await page.locator('[data-span-index="3"]').click();
    await expect(page.getByTestId('reader-panel')).toBeVisible();

    await page.getByTestId('span-to-here').click();
    await page.locator('[data-span-index="7"]').click();

    // 早 is the first character of 早上, so the span runs from 3 to 7 exactly
    // as the drag did.
    await expect.poll(() => sheetQuery(page)).toBe(slice(3, 7));
  });

  test('the control is absent when the engine HAS a caret API', async ({ page }) => {
    // The negative control: without it the case above would pass against a
    // button that is simply always there, degrade or no degrade.
    await openReader(page);
    await page.locator('[data-span-index="3"]').click();
    await expect(page.getByTestId('reader-panel')).toBeVisible();
    await expect(page.getByTestId('span-to-here')).toHaveCount(0);
  });
});
