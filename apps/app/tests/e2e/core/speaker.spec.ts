/**
 * The speaker, completed: hold to slow (docs/plans/core.md C6).
 *
 * **No audio is asserted here and none can be.** Headless Chromium ships no
 * voices at all, so against the real Web Speech adapter the only state this
 * suite can observe is `unavailable` — which is exactly what the first
 * describe block checks, because that state has to look deliberate rather than
 * broken and it is the one every learner on a voiceless device sees.
 *
 * The second block drives the gesture against the **gallery's** provider
 * (`components/gallery/fake-tts.ts`), which reports a voice and settles each
 * utterance on a timer but still produces no sound. What it proves is the
 * wiring nothing else can: a real `pointerdown`, a real 500 ms, a real render,
 * and the character that lights moving from one to the next. The unit suite
 * asserts the sequence's contract; this asserts that a finger reaches it.
 */
import { expect, test, type Page } from '@playwright/test';

import { HOLD_MS } from '../../../components/hanzi/speak-control';
import { DASUAN, openReview, seed } from '../p2/fixtures';

/** The gallery's speaker block, in reading order. */
const BLOCK = '打算明天去北京';

test.describe('a browser with no voices, which is every browser this suite runs', () => {
  /**
   * The unavailable state itself is `tests/e2e/p6/tts.spec.ts`'s, at two
   * surfaces, and is not re-asserted here. What is new at C6 is the control
   * beside it: offering a slow reading on a device that cannot read at all
   * would be the "nothing happens" failure the visible reason exists to
   * prevent, so the slow control is **absent**, not disabled.
   */
  test('the slow control is absent rather than offered and dead', async ({ page }) => {
    await openReview(page);
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);
    // The synchronisation point `tests/e2e/p6/tts.spec.ts` uses: without it the
    // Space can land before the session has mounted its first card, which the
    // spec only loses when the whole suite runs and the page is slower.
    await expect(page.getByTestId('card-back')).toHaveCount(0);
    await expect(page.getByTestId('reveal')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();

    const back = page.getByTestId('card-back');
    await expect(back.getByTestId('speak-button')).toHaveAttribute(
      'data-tts-status',
      'unavailable',
    );
    await expect(back.getByText('No voice', { exact: true })).toBeVisible();
    await expect(back.getByTestId('speak-slow')).toHaveCount(0);
  });
});

/** Press and hold the speaker for `ms`, then release. */
async function holdSpeaker(page: Page, ms: number): Promise<void> {
  const box = await page.getByTestId('speak-button').boundingBox();
  if (!box) throw new Error('the speaker has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** The base character currently lit, if any — `textContent` interleaves the ruby. */
function lit(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const node = document.querySelector('[data-testid="gallery-speaker"] [data-speaking="true"]');
    return node?.firstChild?.textContent ?? null;
  });
}

test.describe('the gesture, against a provider that reports a voice but makes no sound', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/gallery#section-speaker');
    await expect(page.getByTestId('gallery-speaker')).toBeVisible();
    await expect(page.getByTestId('speak-button')).toHaveAttribute('data-tts-status', 'ready');
  });

  /**
   * Every `data-speaking` the passage takes, in order, recorded by a
   * `MutationObserver` in the page.
   *
   * **Polling for one character cannot work here and the first draft tried.**
   * A sequence walks the block in under a second, so a poll that happens to
   * look between two characters reports the wrong one and a poll that starts
   * late reports `null` for ever — which is a flaky test of a real behaviour,
   * the worst kind. Recording every transition asserts the property C6 actually
   * states: the mark advances, once per character, in reading order.
   */
  async function record(page: Page): Promise<void> {
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __lit: string[] }).__lit = seen;
      const root = document.querySelector('[data-testid="gallery-speaker"]')!;
      new MutationObserver(() => {
        const node = root.querySelector('[data-speaking="true"]');
        const char = node?.firstChild?.textContent ?? '';
        if (char && seen.at(-1) !== char) seen.push(char);
      }).observe(root, { subtree: true, attributes: true, attributeFilter: ['data-speaking'] });
    });
  }

  function recorded(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as unknown as { __lit: string[] }).__lit);
  }

  test('holding lights the characters one after another, and releasing clears it', async ({
    page,
  }) => {
    await record(page);
    expect(await lit(page)).toBeNull();

    const box = await page.getByTestId('speak-button').boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();

    // The hold threshold is real time: nothing happens before it.
    await page.waitForTimeout(HOLD_MS - 200);
    expect(await lit(page)).toBeNull();
    expect(await recorded(page)).toEqual([]);

    // …and then it advances, character by character, in reading order. The
    // count is polled and the ORDER asserted, rather than polling for an exact
    // list: the sequence keeps walking while the poll runs, so any fixed list
    // is a race against the block's own length.
    await expect
      .poll(async () => (await recorded(page)).length, { timeout: 8_000 })
      .toBeGreaterThanOrEqual(3);
    const during = await recorded(page);
    expect(during.join('')).toBe(BLOCK.slice(0, during.length));

    await page.mouse.up();
    // Releasing stops the sequence: nothing is left lit, and no further
    // character is ever reached — which is the half a "nothing lit" assertion
    // alone cannot tell from a sequence that simply finished.
    await expect.poll(() => lit(page), { timeout: 3_000 }).toBeNull();
    const atRelease = await recorded(page);
    expect(atRelease.length).toBeLessThan(BLOCK.length);
    await page.waitForTimeout(1_000);
    expect(await recorded(page)).toEqual(atRelease);
  });

  test('a press shorter than the threshold is a tap, and lights nothing', async ({ page }) => {
    await record(page);
    await holdSpeaker(page, Math.max(0, HOLD_MS - 250));
    // A tap is one utterance for the whole block, so no single character is
    // ever the one being read.
    await page.waitForTimeout(400);
    expect(await lit(page)).toBeNull();
    expect(await recorded(page)).toEqual([]);
  });

  test('the Slow button does the same thing without a gesture', async ({ page }) => {
    await record(page);
    const slow = page.getByTestId('speak-slow');
    await expect(slow).toHaveAttribute('aria-pressed', 'false');

    // Keyboard only: Tab from the speaker to the slow control and press it.
    await page.getByTestId('speak-button').focus();
    await page.keyboard.press('Tab');
    await expect(slow).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(slow).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => recorded(page), { timeout: 6_000 }).toContain('打');

    await page.keyboard.press('Enter');
    await expect(slow).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => lit(page), { timeout: 3_000 }).toBeNull();
  });

  test('tapping one character reads that character alone', async ({ page }) => {
    // Rule 3's third clause. What a browser can show is that the tap is
    // *answered* — the block speaker does not start, and nothing is left lit —
    // since the audio itself is unobservable here.
    await record(page);
    const chars = page.getByTestId('gallery-speaker-text').getByTestId('hanzi-char');
    await chars.nth(2).click();
    await page.waitForTimeout(400);
    await expect(page.getByTestId('speak-button')).toHaveAttribute('data-speaking', 'false');
    expect(await lit(page)).toBeNull();
    // …and no sequence started: a character tap is one syllable, not the block.
    expect(await recorded(page)).toEqual([]);
  });
});
