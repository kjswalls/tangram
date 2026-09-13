/**
 * The retention dashboard (Phase 8, `/stats`).
 *
 * Two halves, and the first is the one that matters most: with the demo seed —
 * the state Kirby actually opens the app in — every derived rate on this page
 * has almost nothing behind it, and the page has to say so rather than draw a
 * confident-looking curve over eleven points. The second half seeds a synthetic
 * history through the repository and checks that the numbers that then appear
 * are the right ones, denominator included.
 */
import { expect, test, type Page } from '@playwright/test';

import { ready, resetApp } from './helpers';

const DAY = 86_400_000;

/** Days ago each card was answered Good, oldest first. */
const GOOD_DAYS = [45, 35, 25, 18, 11, 4] as const;
/** Of those, the ones inside the 30-day window the panel reports on. */
const GOOD_IN_WINDOW = GOOD_DAYS.filter((days) => days < 30).length;
const GOOD_CARDS = 20;
const LAPSE_CARDS = 3;

// Every card graduates on an Easy from New (which is a *learning* review and is
// excluded), then answers Good on the days above. The lapse cards answer Good
// once outside the window and Again once inside it.
const REVIEWS_ALL = GOOD_CARDS * GOOD_DAYS.length + LAPSE_CARDS * 2;
const RECALLED_ALL = GOOD_CARDS * GOOD_DAYS.length + LAPSE_CARDS;
const REVIEWS_WINDOW = GOOD_CARDS * GOOD_IN_WINDOW + LAPSE_CARDS;
const RECALLED_WINDOW = GOOD_CARDS * GOOD_IN_WINDOW;
const EXCLUDED = GOOD_CARDS + LAPSE_CARDS;

const percent = (recalled: number, reviews: number) => `${Math.round((recalled / reviews) * 100)}%`;

async function seedHistory(page: Page): Promise<void> {
  await page.evaluate(
    async ({ goodDays, goodCards, lapseCards, day }) => {
      const { repo } = window.__tangram;
      const now = Date.now();
      const make = (name: string) =>
        repo.addPhraseCard([{ text: name, entryId: `${name}|${name}[x]` }], `the ${name} one`, {
          source: 'seed',
          addedAt: now - 70 * day,
        });

      for (let index = 0; index < goodCards; index += 1) {
        const card = await make(`good${index}`);
        // Easy on a New card graduates it straight to Review, so every grade
        // after this one is a retention review.
        await repo.grade(card.id, 4, now - 60 * day);
        for (const days of goodDays) await repo.grade(card.id, 3, now - days * day);
      }

      for (let index = 0; index < lapseCards; index += 1) {
        const card = await make(`lapse${index}`);
        await repo.grade(card.id, 4, now - 60 * day);
        await repo.grade(card.id, 3, now - 40 * day);
        await repo.grade(card.id, 1, now - 10 * day);
      }
    },
    { goodDays: [...GOOD_DAYS], goodCards: GOOD_CARDS, lapseCards: LAPSE_CARDS, day: DAY },
  );
}

test.describe('/stats', () => {
  test('the demo seed gets an honest empty state, not a chart', async ({ page }) => {
    await resetApp(page);
    await page.goto('/?seed=demo');
    await expect(page).toHaveURL(/\/$/, { timeout: 120_000 });
    await expect(page.getByTestId('today-due-count')).not.toHaveText('—', { timeout: 120_000 });

    await page.goto('/stats');
    await expect(page.getByRole('heading', { level: 1, name: 'Stats' })).toBeVisible();

    // The demo's whole history is a handful of backdated grades, most of them
    // of cards still inside their learning steps.
    const retention = page.getByTestId('stats-retention-empty');
    await expect(retention).toBeVisible();
    await expect(retention).toContainText('Not enough reviews yet');
    await expect(retention).toContainText('30');
    await expect(page.getByTestId('stats-retention-rate')).toHaveCount(0);

    const calibration = page.getByTestId('stats-calibration-empty');
    await expect(calibration).toBeVisible();
    await expect(calibration).toContainText('100');
    // Not one dot: the failure mode this page is guarding against is a curve
    // drawn through three points.
    await expect(page.getByTestId('stats-calibration-dot')).toHaveCount(0);

    // Counts, on the other hand, are exact at any size and are shown.
    await expect(page.getByTestId('stats-maturity')).toBeVisible();
    await expect(page.getByTestId('stats-card-total')).toBeVisible();
    await expect(page.getByTestId('stats-maturity-empty')).toHaveCount(0);
  });

  test('reads the real numbers off a seeded history', async ({ page }) => {
    await resetApp(page, { newPerDay: 0 });
    await page.goto('/stats');
    await ready(page);
    await seedHistory(page);
    await page.reload();

    await expect(page.getByTestId('stats-retention-rate')).toHaveText(
      percent(RECALLED_WINDOW, REVIEWS_WINDOW),
    );
    await expect(page.getByTestId('stats-retention-denominator')).toContainText(
      `${RECALLED_WINDOW} of ${REVIEWS_WINDOW} reviews recalled`,
    );
    await expect(page.getByTestId('stats-retention-denominator')).toContainText(
      'already in the Review state',
    );
    await expect(page.getByTestId('stats-retention-all')).toContainText(
      percent(RECALLED_ALL, REVIEWS_ALL),
    );
    // The tile's caption carries the all-time denominator beside the rate.
    await expect(page.getByTestId('stats-retention')).toContainText(
      `${RECALLED_ALL} of ${REVIEWS_ALL} reviews`,
    );
    // The graduating Easy grades are excluded from the rate — and counted, so
    // the two figures add back up to the review log.
    await expect(page.getByTestId('stats-retention-excluded')).toContainText(String(EXCLUDED));

    // Calibration now has something to say, and says how much of it it drew.
    await expect(page.getByTestId('stats-calibration-empty')).toHaveCount(0);
    const dots = page.getByTestId('stats-calibration-dot');
    expect(await dots.count()).toBeGreaterThan(0);
    await expect(page.getByTestId('stats-calibration-note')).toContainText(
      `${REVIEWS_ALL} reviews of cards in the Review state`,
    );
    for (const dot of await dots.all()) {
      // Nothing thin reached the chart.
      expect(Number(await dot.getAttribute('data-count'))).toBeGreaterThanOrEqual(10);
    }

    // Workload: four days carry the whole cohort, one carries the lapses.
    await expect(page.getByTestId('stats-workload-empty')).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="stats-workload-row"][data-reviewed="${GOOD_CARDS}"]`),
    ).toHaveCount(GOOD_IN_WINDOW);
    await expect(
      page.locator(`[data-testid="stats-workload-row"][data-reviewed="${LAPSE_CARDS}"]`),
    ).toHaveCount(1);
    await expect(page.getByTestId('stats-workload-note')).toContainText(
      `${LAPSE_CARDS} are already overdue`,
    );

    // Maturity: the lapsed cards are the only ones not in Review.
    await expect(page.getByTestId('stats-state-review')).toHaveText(String(GOOD_CARDS));
    await expect(page.getByTestId('stats-state-relearning')).toHaveText(String(LAPSE_CARDS));
    await expect(page.getByTestId('stats-state-new')).toHaveText('0');
    await expect(page.getByTestId('stats-card-total')).toContainText(
      String(GOOD_CARDS + LAPSE_CARDS),
    );
  });

  test('is reachable from the nav and reads on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Stats', exact: true })
      .click();
    await expect(page).toHaveURL(/\/stats$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Stats' })).toBeVisible();

    // Charts scale to the viewport rather than pushing the page sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
