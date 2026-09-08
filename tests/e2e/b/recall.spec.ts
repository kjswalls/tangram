import { expect, test } from '@playwright/test';

import { DASUAN, openReview, readerContext, reviewRows, seed } from '../p2/fixtures';
import { ready } from '../p3/helpers';

/**
 * Free-recall grading (PLAN.md §4, Phase 6 item 2), through the app as a
 * learner meets it: turn it on in /settings, review a card, type what you think
 * it means, read the suggestion — and then grade it with a different key.
 *
 * The assertion the feature lives or dies by is the last one: the review row
 * records the grade the learner pressed, not the one the provider suggested.
 * Everything else here (the flip that does not wait, the failure that says
 * nothing much) is the same promise seen from the other side — the suggestion
 * is advice, and the app never acts on it.
 */
test.describe('/review with free recall on', () => {
  test('suggests a grade and records the one the learner presses instead', async ({ page }) => {
    await openReview(page);

    // The switch is a real setting, thrown the way a person throws it.
    await page.goto('/settings');
    const toggle = page.getByTestId('settings-free-recall');
    await expect(toggle).not.toBeChecked();
    // A click, not `check()`: this is a controlled checkbox whose write is
    // async, so React restores the box to `false` for the tick between the
    // click and the saved row — and `check()` calls that a failed click.
    await toggle.click();
    await expect(toggle).toBeChecked();
    // The form writes through with no Save button, so wait for the row itself
    // rather than for the checkbox: /review reads the setting, not the DOM.
    await page.waitForFunction(
      async () => (await window.__tangram.repo.getSettings()).freeRecall === true,
    );

    await page.goto('/review');
    await ready(page);
    await seed(page, [{ entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 }]);

    // The box is on the front, where recall happens — before the answer is up.
    await expect(page.getByTestId('card-recall')).toBeVisible();
    await expect(page.getByTestId('card-back')).toHaveCount(0);

    await page.getByTestId('recall-answer').fill('to plan, to intend');
    await page.getByTestId('recall-answer').press('Enter');

    // The flip does not wait for the grader.
    await expect(page.getByTestId('card-back')).toBeVisible();
    expect(await reviewRows(page)).toHaveLength(1); // the seed's backdated grade, and nothing else

    const suggestion = page.getByTestId('recall-suggestion');
    await expect(suggestion).toBeVisible();
    await expect(suggestion).toHaveAttribute('data-suggested', '4');
    await expect(page.getByTestId('recall-why')).not.toBeEmpty();
    await expect(page.getByTestId('grade-4')).toHaveAttribute('data-suggested', 'true');
    await expect(page.getByTestId('grade-2')).not.toHaveAttribute('data-suggested', 'true');

    // Still nothing written: a suggestion on screen is not a grade.
    expect(await reviewRows(page)).toHaveLength(1);

    // The learner overrides it.
    await page.keyboard.press('2');
    await expect(page.getByTestId('review-empty')).toBeVisible();

    const rows = await reviewRows(page);
    expect(rows).toHaveLength(2);
    expect(rows[rows.length - 1].rating).toBe(2);
    // What the model thought never reached the database.
    expect(rows.some((row) => row.rating === 4)).toBe(false);
  });

  test('a failing grader costs the learner nothing but the suggestion', async ({ page }) => {
    await openReview(page);
    await page.evaluate(() => window.__tangram.repo.setSettings({ freeRecall: true }));
    await page.route('**/api/recall', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'provider-failed', hint: 'no grader here' }),
      }),
    );
    await seed(page, [{ entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 }]);

    await page.getByTestId('recall-answer').fill('to plan');
    await page.getByTestId('recall-answer').press('Enter');

    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('recall-no-suggestion')).toBeVisible();
    await expect(page.getByTestId('recall-suggestion')).toHaveCount(0);
    // No banner, no dialog, nothing red: the four buttons are the whole answer.
    await expect(page.getByTestId('review-error')).toHaveCount(0);

    await page.getByTestId('grade-3').click();
    await expect(page.getByTestId('review-empty')).toBeVisible();
    const rows = await reviewRows(page);
    expect(rows[rows.length - 1].rating).toBe(3);
  });

  test('flipping without typing asks nobody', async ({ page }) => {
    await openReview(page);
    await page.evaluate(() => window.__tangram.repo.setSettings({ freeRecall: true }));

    let asked = 0;
    await page.route('**/api/recall', (route) => {
      asked += 1;
      return route.continue();
    });
    await seed(page, [{ entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 }]);

    await page.getByTestId('recall-answer').press('Enter');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('recall-suggestion')).toHaveCount(0);
    await expect(page.getByTestId('recall-no-suggestion')).toHaveCount(0);
    expect(asked).toBe(0);
  });
});
