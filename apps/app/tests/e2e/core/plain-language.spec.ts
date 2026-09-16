/**
 * Plain language, as a learner meets it (docs/plans/core.md C8).
 *
 * C8 is a relabelling phase, and a relabelling phase is exactly the kind that
 * ships broken without anyone noticing: every unit test still passes, because
 * nothing about the scheduler changed. What can break is what a person can see
 * — a label that wraps out of its button, a sentence that says nothing, an
 * order of operations that makes no sense the first time.
 *
 * So these are the criteria C8 words as "e2e at 390px", one spec each, and each
 * one is about a thing a learner does rather than a string a grep can find.
 */
import { expect, test, type Page } from '@playwright/test';

import { DASUAN, openReview, seed } from '../p2/fixtures';
import { expectTodayCounts, ready, resetApp } from '../p3/helpers';

const PHONE = { width: 390, height: 844 };

/** Seed one due card and flip it, so the grade bar is on screen. */
async function revealed(page: Page): Promise<void> {
  await openReview(page);
  await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);
  await expect(page.getByTestId('reveal')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('grade-bar')).toBeVisible();
}

test.describe('the four grade buttons', () => {
  test('are a 2×2 grid at 390px, unclipped, with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await revealed(page);

    const boxes = [];
    for (const rating of [1, 2, 3, 4]) {
      const button = page.getByTestId(`grade-${rating}`);
      await expect(button).toBeVisible();
      boxes.push((await button.boundingBox())!);
    }
    // Two rows of two: 1 and 2 share a top, 3 and 4 share a lower one.
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
    expect(Math.abs(boxes[2].y - boxes[3].y)).toBeLessThan(2);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 2);

    // **Nothing clipped.** "Barely remembered" is the constraint: it wraps to
    // two lines in a 170px button, and a button whose content is taller than
    // its box is a label the learner cannot read.
    for (const rating of [1, 2, 3, 4]) {
      const fits = await page.getByTestId(`grade-${rating}`).evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
      expect(fits.scrollHeight, `grade-${rating} clips vertically`).toBeLessThanOrEqual(
        fits.clientHeight + 1,
      );
      expect(fits.scrollWidth, `grade-${rating} clips horizontally`).toBeLessThanOrEqual(
        fits.clientWidth + 1,
      );
    }

    // …and the page itself does not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('say what they mean, and "Got it" is the only filled button on the screen', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await revealed(page);

    for (const [rating, label] of [
      [1, 'Forgot it'],
      [2, 'Barely remembered'],
      [3, 'Got it'],
      [4, 'Instant'],
    ] as const) {
      await expect(page.getByTestId(`grade-${rating}`)).toContainText(label);
    }

    // The single primary action, in the practice accent (§1 gives Practice
    // vermillion). Counted over the whole screen, because "the only filled
    // button" is a claim about the screen and not about the bar.
    const primaries = await page.locator('[data-variant="primary"]:visible').all();
    const ids = await Promise.all(primaries.map((node) => node.getAttribute('data-testid')));
    expect(ids).toEqual(['grade-3']);

    // …and no coaching line. It was explicitly rejected.
    await expect(page.getByTestId('grade-dock')).not.toContainText(/be honest|don't worry|try to/i);
  });

  test('each carries the interval it would really schedule', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await revealed(page);
    // Not a hardcoded table: the subtitle comes from `gradeOptions()` on this
    // card's own state, which is what C8 says must survive the relabelling.
    for (const rating of [1, 2, 3, 4]) {
      const interval = await page.getByTestId(`grade-${rating}`).getAttribute('data-interval');
      expect(interval, `grade-${rating}`).toMatch(/^\d+(\.\d)?(m|h|d|mo|y)$/);
      await expect(page.getByTestId(`grade-${rating}`)).toContainText(interval!);
    }
  });
});

test.describe('the order of operations', () => {
  test('a recognise card asks, then shows the answer, then grades', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openReview(page);
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);

    // The question is stated rather than inferred.
    await expect(page.getByTestId('card-prompt')).toHaveText('Do you remember it?');
    await expect(page.getByTestId('reveal')).toHaveText('Show the answer');

    // **The grade bar is not in the accessibility tree before the answer is.**
    // Not merely invisible: a screen-reader learner tabbing the page must not
    // find four buttons whose labels are the answer to the question in front of
    // them.
    await expect(page.getByTestId('grade-bar')).toHaveCount(0);
    for (const rating of [1, 2, 3, 4]) {
      await expect(page.getByTestId(`grade-${rating}`)).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: 'Got it' })).toHaveCount(0);

    await page.getByTestId('reveal').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByRole('button', { name: /Got it/ })).toBeVisible();
    await expect(page.getByTestId('reveal')).toHaveCount(0);
  });
});

test.describe('Today, in one sentence', () => {
  test('is a sentence with the counts and a duration, and neither number tile', async ({
    page,
  }) => {
    await resetApp(page, { newPerDay: 3 });
    await page.goto('/');
    await ready(page);
    await expectTodayCounts(page, { fresh: 3 }, { timeout: 60_000 });

    const sentence = page.getByTestId('today-sentence');
    await expect(sentence).toContainText('3 new words to learn');
    // A duration, rounded, with no false precision.
    await expect(sentence).toContainText(/About (a|two|three|four|five|six|\d+) minutes?\./);
    await expect(sentence).not.toContainText(/\d+\.\d/);

    // **The tiles are gone, not hidden inside the sentence as spans.** C8 asks
    // for this to be said out loud: these three test ids no longer exist.
    for (const tile of ['today-due-count', 'today-new-count', 'today-direction-split']) {
      await expect(page.getByTestId(tile)).toHaveCount(0);
    }
    // …and no clause is a zero.
    await expect(sentence).not.toContainText(/\b0 /);
  });
});

test.describe('Library, in the learner’s own terms', () => {
  test('a fresh database is "Just starting", and the spine really is HSK 1', async ({ page }) => {
    await resetApp(page);
    await page.goto('/library');
    await ready(page);

    const level = page.getByTestId('learner-level-sentence');
    await expect(level).toContainText('Just starting');
    await expect(level).toContainText('new words come from HSK 1, easiest first');
    // The presentation and the setting agree, which is the whole point of the
    // line: it is a prediction the learner can check tomorrow.
    expect(await page.evaluate(() => window.__tangram.repo.getSettings())).toMatchObject({
      spineStartBand: 1,
    });
    await expect(page.getByTestId('learner-level-change')).toBeVisible();
  });

  test('the pinyin control offers exactly three options', async ({ page }) => {
    await resetApp(page);
    await page.goto('/library');
    await ready(page);

    const control = page.getByTestId('settings-pinyin-display');
    await expect(control).toBeVisible();
    expect(await control.locator('option').allTextContents()).toEqual([
      'Always',
      'Only when I tap',
      'Never',
    ]);
    // The one option that is not self-evident carries its own line.
    await expect(control.locator('xpath=..')).toContainText('tap a word');
  });
});

test.describe('the pinyin control changes a real passage', () => {
  /**
   * C8's criterion, as one spec with three assertions, "driving the real
   * setting" — not the context, not a prop. C3 built `pinyinDisplay` and
   * specified exactly what each value does to the rendering; until C8 nothing
   * let a learner reach it, so this is the first time the three states have
   * been exercised end to end.
   */
  const PASSAGE = '我打算明天去北京。';

  async function readWith(page: Page, display: 'always' | 'tap' | 'never'): Promise<void> {
    await page.evaluate(
      (value) => window.__tangram.repo.setSettings({ pinyinDisplay: value }),
      display,
    );
    await page.goto('/read');
    await ready(page);
    await page.getByTestId('reader-input').fill(PASSAGE);
    await page.getByTestId('read-text').click();
    await expect(page.getByTestId('reader-text')).toBeVisible();
    await expect(page.getByTestId('reader-token').first()).not.toHaveAttribute(
      'data-state',
      'unknown',
    );
  }

  const readings = (page: Page) => page.getByTestId('reader-text').locator('rt');

  test('always shows every reading, never shows none, tap waits to be asked', async ({ page }) => {
    await resetApp(page, { newPerDay: 0 });

    // always — every Chinese character is annotated.
    await readWith(page, 'always');
    await expect.poll(() => readings(page).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(8);

    // never — nothing is, however long you wait.
    await readWith(page, 'never');
    await expect(page.getByTestId('reader-token').first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(await readings(page).count()).toBe(0);

    // tap — nothing until a word is asked for, then that word.
    await readWith(page, 'tap');
    await page.waitForTimeout(500);
    expect(await readings(page).count()).toBe(0);
    await page.locator('[data-testid="reader-token"][data-token="打算"]').first().click();
    await expect.poll(() => readings(page).count(), { timeout: 10_000 }).toBeGreaterThan(0);
    // …that word, and not the whole passage.
    expect(await readings(page).count()).toBeLessThan(8);
  });
});
