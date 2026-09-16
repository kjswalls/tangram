/**
 * The seven pieces (docs/plans/core.md C8; `wave-zero.md` §7).
 *
 * product-decisions §11 calls the tangram the one playful element in the whole
 * design, and §7 had to *reinstate* it because it appeared in no phase of any
 * plan. It is small, so the risk is not that it breaks — it is that it becomes
 * decoration: a square that fills on a timer, or one that reports a fraction
 * nobody can hear. C8 names four rules and these are them.
 *
 * The accessible value is the one that has to be exact. "If the piece count and
 * the item count disagree, the pieces round; the accessible value does not."
 */
import { expect, test, type Page } from '@playwright/test';

import { DASUAN, KANKAN, openReview, seed } from '../p2/fixtures';
import { ready, resetApp } from '../p3/helpers';

const bar = (page: Page) => page.getByTestId('tangram-progress').getByRole('progressbar');

async function filledCount(page: Page): Promise<number> {
  return page.locator('[data-testid="tangram-piece"][data-state="filled"]').count();
}

/** Reveal and grade "Instant", so nothing comes back inside the session. */
async function answer(page: Page): Promise<void> {
  await page.getByTestId('reveal').click();
  await expect(page.getByTestId('card-back')).toBeVisible();
  await page.getByTestId('grade-4').click();
}

test.describe('the tangram fills as the session runs', () => {
  test('empty at the start, half way at half way, complete at the end', async ({ page }) => {
    await openReview(page);
    // Four cards, so "half the merged queue" is exactly two.
    await seed(page, [
      { entry: DASUAN, gradedDaysAgo: 30 },
      { entry: KANKAN, gradedDaysAgo: 31 },
      { entry: { ...DASUAN, id: '明天|明天[ming2 tian1]', simp: '明天', trad: '明天', pinyinNum: 'ming2 tian1', pinyinMarked: 'míngtiān', glosses: ['tomorrow'] }, gradedDaysAgo: 32 },
      { entry: { ...KANKAN, id: '北京|北京[bei3 jing1]', simp: '北京', trad: '北京', pinyinNum: 'bei3 jing1', pinyinMarked: 'běijīng', glosses: ['Beijing'] }, gradedDaysAgo: 33 },
    ]);
    await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 30_000 });

    // Seven pieces, and none of them filled.
    await expect(page.getByTestId('tangram-piece')).toHaveCount(7);
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '0');
    await expect(bar(page)).toHaveAttribute('aria-valuemax', '4');
    expect(await filledCount(page)).toBe(0);

    await answer(page);
    await answer(page);

    // **Half.** The accessible value is exact; the pieces round.
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '2');
    await expect(bar(page)).toHaveAttribute('aria-valuemax', '4');
    const half = await filledCount(page);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(7);

    await answer(page);
    await answer(page);

    // The square is complete, and it is on screen to be seen: the last grade
    // ends the session, so a square that only existed mid-session would never
    // be finished in front of anyone.
    await expect(page.getByTestId('review-empty')).toBeVisible();
    await expect(page.getByTestId('tangram-piece')).toHaveCount(7);
    expect(await filledCount(page)).toBe(7);
    await expect(bar(page)).toHaveAttribute('aria-valuenow', '4');
    await expect(bar(page)).toHaveAttribute('aria-valuemax', '4');
  });

  test('says what it means, in words, not only in shapes', async ({ page }) => {
    await openReview(page);
    await seed(page, [{ entry: DASUAN, gradedDaysAgo: 30 }]);
    await expect(page.getByTestId('review-session')).toBeVisible({ timeout: 30_000 });

    // A filling square is not an accessible progress report on its own.
    await expect(bar(page)).toHaveAttribute('aria-valuetext', '0 of 1 done');
    await expect(page.getByTestId('tangram-label')).toHaveText('0 of 1 done');
    // No jargon anywhere near it.
    await expect(page.getByTestId('tangram-progress')).not.toContainText(/card|due|interval/i);

    await answer(page);
    await expect(page.getByTestId('tangram-label')).toHaveText('All done');
  });

  test('is absent on an idle Practice tab', async ({ page }) => {
    // Nothing to do and nothing done: no session, so no square.
    await resetApp(page, { newPerDay: 0 });
    await page.goto('/practice');
    await ready(page);
    await expect(page.getByTestId('review-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tangram-progress')).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
  });
});
