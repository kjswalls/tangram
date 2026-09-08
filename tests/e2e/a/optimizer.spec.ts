/**
 * Phase 8 items 2 and 3 — fitting FSRS to the learner, in a real browser.
 *
 * The maths is proved in `tests/unit/fsrs-optimize/`. What only a browser can
 * show is the rest of the promise: that the panel refuses below the floor,
 * that a few hundred replays of the review log run in chunks rather than
 * locking the tab, that a run applies nothing on its own, and that Revert puts
 * the parameters back.
 *
 * The review log is written straight into the `reviews` table rather than
 * ground out through `repo.grade`, because a thousand real grades is a minute
 * of test for no extra truth — the optimizer reads that table and nothing else.
 */
import { expect, test, type Page } from '@playwright/test';

import type { ReviewRow, StoredRating } from '@/lib/db';
import { ready, resetApp } from '../p3/helpers';

/**
 * A deterministic review log: `cards` cards, six reviews each, gaps and
 * ratings from a seeded generator so every run of this spec sees the same
 * history and the same fit.
 */
async function seedLog(page: Page, cards: number): Promise<number> {
  return page.evaluate(async (count: number) => {
    const DAY = 86_400_000;
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const rows: ReviewRow[] = [];
    const start = Date.UTC(2024, 0, 1);
    for (let c = 0; c < count; c += 1) {
      let at = start + Math.floor(next() * 200) * DAY;
      let elapsed = 0;
      let stability = 1;
      for (let i = 0; i < 6; i += 1) {
        const roll = next();
        const rating: StoredRating = roll < 0.2 ? 1 : roll < 0.35 ? 2 : roll < 0.9 ? 3 : 4;
        rows.push({
          id: `seed-${c}-${i}`,
          cardId: `seed-card-${c}`,
          rating,
          reviewedAt: at,
          before: {
            state: i === 0 ? (0 as const) : (2 as const),
            due: at,
            stability,
            difficulty: 5,
            reps: i,
            lapses: 0,
            scheduled_days: elapsed,
            learning_steps: 0,
            ...(i === 0 ? {} : { last_review: at - elapsed * DAY }),
          },
          log: {
            rating,
            state: i === 0 ? (0 as const) : (2 as const),
            due: at,
            stability,
            difficulty: 5,
            elapsed_days: elapsed,
            last_elapsed_days: elapsed,
            scheduled_days: elapsed,
            learning_steps: 0,
            review: at,
          },
          createdAt: at,
        });
        stability = rating === 1 ? Math.max(1, stability * 0.5) : stability * 1.8;
        elapsed = Math.max(1, Math.round(stability * (0.8 + next() * 0.4)));
        at += elapsed * DAY;
      }
    }
    await window.__tangram.db.reviews.bulkAdd(rows);
    return rows.length;
  }, cards);
}

test.describe('/settings — fitting FSRS to this learner', () => {
  test('refuses below the floor, and says why in the learner’s own terms', async ({ page }) => {
    await resetApp(page);
    await seedLog(page, 10);
    await page.reload();
    await ready(page);

    await expect(page.getByTestId('optimizer-panel')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('optimizer-review-count')).toContainText(
      /\d+ of your 60 reviews can be scored/,
    );
    await expect(page.getByTestId('optimizer-floor')).toContainText(
      'floor for signal rather than a guarantee',
    );
    await expect(page.getByTestId('optimizer-run')).toBeDisabled();
  });

  test('runs without locking the tab, and applies nothing on its own', async ({ page }) => {
    await resetApp(page);
    await seedLog(page, 150);
    await page.reload();
    await ready(page);

    const run = page.getByTestId('optimizer-run');
    await expect(run).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId('optimizer-floor')).toHaveCount(0);
    await run.click();

    // The page is still answering while the fit runs — the search yields
    // between chunks, so this click is handled rather than queued behind it.
    await expect(page.getByTestId('optimizer-cancel')).toBeVisible({ timeout: 30_000 });

    const result = page.getByTestId('optimizer-result');
    await expect(result).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('optimizer-scores')).toContainText('it never saw');

    // Whatever the fit decided, it decided nothing on the learner's behalf.
    const stored = await page.evaluate(async () => {
      const settings = await window.__tangram.repo.getSettings();
      return settings.fsrsWeights;
    });
    expect(stored).toBeNull();
    await expect(page.getByTestId('optimizer-source')).toHaveText('FSRS defaults');
  });

  test('a fit in force can always be undone', async ({ page }) => {
    await resetApp(page);
    await page.evaluate(async () => {
      await window.__tangram.repo.setSettings({
        fsrsWeights: {
          w: [
            0.4, 1.2, 3.1, 15.7, 7.2, 0.5, 1.5, 0.01, 1.6, 0.1, 1.0, 2.0, 0.05, 0.34, 1.3, 0.29,
            2.6, 0.0, 0.6, 0.2, 0.2,
          ],
          fittedAt: Date.UTC(2026, 2, 3),
          reviewCount: 1240,
          heldOutLogLoss: 0.31,
          baselineLogLoss: 0.34,
        },
      });
    });
    await page.reload();
    await ready(page);

    await expect(page.getByTestId('optimizer-source')).toContainText('Optimized from your 1,240', {
      timeout: 60_000,
    });
    const revert = page.getByTestId('optimizer-revert');
    await expect(revert).toHaveText('Revert to FSRS defaults');
    await revert.click();

    await expect(page.getByTestId('optimizer-status')).toHaveText('Back to the FSRS defaults.');
    await expect(page.getByTestId('optimizer-source')).toHaveText('FSRS defaults');
    expect(
      await page.evaluate(async () => (await window.__tangram.repo.getSettings()).fsrsWeights),
    ).toBeNull();
  });
});
