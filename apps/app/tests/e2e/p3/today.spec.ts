/**
 * Today and the day's cap (PLAN.md §4 P3), **after the Practice-queue merge**
 * (docs/plans/core.md C7; `wave-zero.md` §9).
 *
 * The behaviour these cases describe has moved, and it is the point of the
 * merge rather than a side effect. Opening Today used to *introduce* the day's
 * new words — draw them, create their cards and charge
 * `settings.introduced[dayKey]` — so a learner who opened the app and closed it
 * again had spent the day's ten. Since C7 **Practice is the only place any of
 * the three is reached**: Today reports what the session will offer and creates
 * nothing.
 *
 * So every case below asserts the count on Today *before* anything exists, and
 * then opens Practice to make it so. What has not changed, and is asserted
 * harder than before, is the cap: the charge still happens at card creation,
 * and a reload still hands out nothing further.
 */
import { expect, test } from '@playwright/test';

import { expectTodayCounts, gradeAllNew, ready, resetApp } from './helpers';

/** Open Practice and wait for the session to have loaded (or be empty). */
async function practice(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/practice');
  await expect(
    page.getByTestId('review-session').or(page.getByTestId('review-empty')),
  ).toBeVisible({ timeout: 60_000 });
}

test.describe('today', () => {
  test('reports three new words without creating any, and Practice creates them', async ({
    page,
  }) => {
    await resetApp(page);
    await page.goto('/library');
    await page.getByTestId('settings-new-per-day').fill('3');
    await expect(page.getByTestId('settings-status')).toHaveText('Saved');

    await page.goto('/');
    await expectTodayCounts(page, { fresh: 3, practice: 0, write: 0 }, { timeout: 60_000 });
    // **Nothing has been created.** This is the half the merge is about: the
    // number is what the cap allows, and the database is still empty.
    await expect(page.getByText('0 of 3 new words introduced today')).toBeVisible();
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toHaveLength(0);

    await practice(page);
    const cards = await page.evaluate(() => window.__tangram.repo.allCards());
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.fsrs.state === 0)).toBe(true);
    expect(cards.every((card) => card.context?.source === 'list')).toBe(true);

    // Back on Today: the same three, now real, and the charge is on the record.
    await page.goto('/');
    await expectTodayCounts(page, { fresh: 3 }, { timeout: 60_000 });
    await expect(page.getByTestId('today-new-word')).toHaveCount(3);
    await expect(page.getByText('3 of 3 new words introduced today')).toBeVisible();

    // A second visit to Practice introduces nothing further: the counter is
    // persisted and charged at creation, not at grading.
    await practice(page);
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toHaveLength(3);
  });

  test('after grading the day’s ten, no further spine cards are offered today', async ({
    page,
  }) => {
    await resetApp(page);
    await page.goto('/');
    await expectTodayCounts(page, { fresh: 10 }, { timeout: 60_000 });

    await practice(page);
    expect(await gradeAllNew(page)).toBe(10);

    await page.goto('/');
    await expectTodayCounts(page, { fresh: 0, practice: 0, write: 0 });
    await expect(page.getByTestId('today-new-list')).toHaveCount(0);
    // Graded, not deleted: FSRS scheduled them a day or more out.
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toHaveLength(10);

    // …and opening Practice again does not hand out a second ten.
    await practice(page);
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toHaveLength(10);
  });

  test('marking HSK 1–3 known moves the day’s new words to band 4', async ({ page }) => {
    await resetApp(page, { newPerDay: 4 });
    await page.goto('/library');
    for (const name of ['HSK 1', 'HSK 2', 'HSK 3']) {
      const card = page.locator(`[data-list-name="${name}"]`);
      // Library materialises HSK membership in the background, band by band,
      // and a card cannot know whether everything in it is already known until
      // its own band has arrived. The count appearing is that signal — waiting
      // on it is what makes the rest of this deterministic under load, where
      // the fill used to land in the middle of the click below.
      await expect(card.getByTestId('list-count')).toBeVisible({ timeout: 180_000 });

      const button = card.getByRole('button', { name: `Mark all known: ${name}` });
      // Bands at or below `settings.knownBand` (2 by default) are known by
      // assumption, so HSK 1 and HSK 2 arrive already spent — the button is
      // disabled because there is nothing to do, not because a write is in
      // flight, and `data-mark-state` is what tells those two apart. Clicking a
      // button that will never enable is what the 30 s retry used to be.
      if ((await button.getAttribute('data-mark-state')) === 'idle') await button.click();

      await expect(button).toHaveText('All known', { timeout: 120_000 });
      await expect(button).toHaveAttribute('data-mark-state', 'all-known');
    }

    await page.goto('/');
    await expectTodayCounts(page, { fresh: 4 }, { timeout: 60_000 });
    await practice(page);
    const cards = await page.evaluate(() => window.__tangram.repo.allCards());
    expect(cards).toHaveLength(4);
    for (const card of cards) expect(card.snapshot).toMatchObject({ hskBand: 4 });
  });

  test('Start practice goes to the Practice tab, and is dead when there is nothing to do', async ({
    page,
  }) => {
    await resetApp(page, { newPerDay: 0 });
    await page.goto('/');
    await ready(page);
    await expectTodayCounts(page, { fresh: 0 }, { timeout: 60_000 });
    await expect(page.getByTestId('start-review')).toBeDisabled();

    await page.evaluate(() => window.__tangram.repo.setSettings({ newPerDay: 2 }));
    await page.reload();
    await expectTodayCounts(page, { fresh: 2 }, { timeout: 60_000 });
    await page.getByTestId('start-review').click();
    await expect(page).toHaveURL(/\/practice$/);
  });
});
