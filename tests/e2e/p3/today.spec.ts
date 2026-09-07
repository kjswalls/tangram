/**
 * Today and settings (PLAN.md §4 P3): the counts, the daily cap across a reload,
 * and where the spine draws from once the low bands are known.
 */
import { expect, test } from '@playwright/test';

import { gradeAllNew, ready, resetApp } from './helpers';

test.describe('today', () => {
  test('setting new-per-day to 3 gives Today exactly three new words', async ({ page }) => {
    await resetApp(page);
    await page.goto('/settings');
    await page.getByTestId('settings-new-per-day').fill('3');
    await expect(page.getByTestId('settings-status')).toHaveText('Saved');

    await page.goto('/');
    await expect(page.getByTestId('today-new-count')).toHaveText('3', { timeout: 60_000 });
    await expect(page.getByTestId('today-due-count')).toHaveText('0');
    await expect(page.getByTestId('today-new-word')).toHaveCount(3);
    await expect(page.getByText('3 of 3 new words introduced today')).toBeVisible();

    // Introducing is what the page did, so the cards are real and are band 3 —
    // the default spine start.
    const cards = await page.evaluate(() => window.__tangram.repo.allCards());
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.fsrs.state === 0)).toBe(true);
    expect(cards.every((card) => card.context?.source === 'list')).toBe(true);

    // A reload introduces nothing further: the counter is persisted.
    await page.reload();
    await expect(page.getByTestId('today-new-count')).toHaveText('3');
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toHaveLength(3);
  });

  test('after grading the day’s ten, no further spine cards are offered today', async ({ page }) => {
    await resetApp(page);
    await page.goto('/');
    await expect(page.getByTestId('today-new-count')).toHaveText('10', { timeout: 60_000 });

    expect(await gradeAllNew(page)).toBe(10);
    await page.reload();
    await expect(page.getByTestId('today-new-count')).toHaveText('0');
    await expect(page.getByTestId('today-due-count')).toHaveText('0');
    await expect(page.getByTestId('today-new-list')).toHaveCount(0);
    // Graded, not deleted: FSRS scheduled them a day or more out.
    expect(await page.evaluate(() => window.__tangram.repo.allCards())).toHaveLength(10);
  });

  test('marking HSK 1–3 known moves the day’s new words to band 4', async ({ page }) => {
    await resetApp(page, { newPerDay: 4 });
    await page.goto('/lists');
    for (const name of ['HSK 1', 'HSK 2', 'HSK 3']) {
      const card = page.locator(`[data-list-name="${name}"]`);
      await card.getByRole('button', { name: `Mark all known: ${name}` }).click();
      await expect(card.getByRole('button', { name: `Mark all known: ${name}` })).toHaveText(
        'All known',
        { timeout: 120_000 },
      );
    }

    await page.goto('/');
    await expect(page.getByTestId('today-new-count')).toHaveText('4', { timeout: 60_000 });
    const cards = await page.evaluate(() => window.__tangram.repo.allCards());
    expect(cards).toHaveLength(4);
    for (const card of cards) expect(card.snapshot).toMatchObject({ hskBand: 4 });
  });

  test('Start review links to the review route and is dead when there is nothing to do', async ({
    page,
  }) => {
    await resetApp(page, { newPerDay: 0 });
    await page.goto('/');
    await ready(page);
    await expect(page.getByTestId('today-new-count')).toHaveText('0', { timeout: 60_000 });
    await expect(page.getByTestId('start-review').getByRole('button')).toBeDisabled();

    await page.evaluate(() => window.__tangram.repo.setSettings({ newPerDay: 2 }));
    await page.reload();
    await expect(page.getByTestId('today-new-count')).toHaveText('2', { timeout: 60_000 });
    await page.getByTestId('start-review').click();
    await expect(page).toHaveURL(/\/review$/);
  });
});
