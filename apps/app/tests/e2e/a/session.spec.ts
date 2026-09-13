/**
 * Phase 8 item 1 — the session under `settings.shortTermSteps`.
 *
 * v1 ran FSRS with `enable_short_term: false`, so nothing could ever be
 * scheduled inside a session and the queue could only shorten. Since Phase 8
 * the setting defaults to ts-fsrs's own `true`: Again on a new card is a
 * minute, Good is ten, and a card can mature while the learner is still
 * sitting there. What is asserted here and nowhere else:
 *
 *  - the empty state says **minutes**, and how many cards are coming back;
 *  - the session **fetches the card back on its own** when it matures, with no
 *    reload — the failure this replaces is an empty state that stood there
 *    until the page was refreshed;
 *  - turning the setting off puts every grade a day out again, from the same
 *    database and the same card.
 *
 * The intra-session repeat cap is *not* here: proving it means grading one card
 * six times with a one-minute learning step between each, and the session's
 * refresh timer is armed from the schedule the grade wrote — moving the due
 * column behind the app's back does not re-arm it, and nothing in the product
 * ever does that. It is proved instead against the real component and a real
 * database in `tests/unit/srs/review-session.test.tsx`, which can move the
 * clock by hand.
 */
import { expect, test, type Page } from '@playwright/test';

import type { Repository, TangramDb } from '@/lib/db';
import { DASUAN, openReview, readerContext, seed, storedCard } from '../p2/fixtures';

const DAY_MS = 86_400_000;

type TangramWindow = Window & { __tangram?: { repo: Repository; db: TangramDb } };

/** Move a card's due instant, both columns, the way the clock eventually will. */
async function setDue(page: Page, cardId: string, at: number): Promise<void> {
  await page.evaluate(
    async ({ id, due }: { id: string; due: number }) => {
      await (window as TangramWindow).__tangram!.db.cards.update(id, { due, 'fsrs.due': due });
    },
    { id: cardId, due: at },
  );
}

function reviewCount(page: Page, cardId: string): Promise<number> {
  return page.evaluate(async (id: string) => {
    const rows = await (window as TangramWindow).__tangram!.db.reviews.toArray();
    return rows.filter((row) => row.cardId === id).length;
  }, cardId);
}

test.describe('/review with the short learning steps on', () => {
  test('says how many cards come back, and how many minutes away they are', async ({ page }) => {
    await openReview(page);
    const [id] = await seed(page, [{ entry: DASUAN, context: readerContext() }]);

    await expect(page.getByTestId('card-front')).toContainText('打算');
    await page.getByTestId('reveal').click();
    // Again on a new card is the first learning step — a minute, not a day.
    await page.getByTestId('grade-1').click();

    await expect(page.getByTestId('review-empty')).toHaveText(
      /^Nothing due — 1 card comes back in \d+ minutes?\.$/,
    );
    const stored = await storedCard(page, id);
    expect(stored!.due - Date.now()).toBeLessThan(DAY_MS);
    // FSRS Learning — a state that never occurred at all under v1.
    expect(stored!.fsrs.state).toBe(1);
  });

  test('brings a matured card back on its own, with no reload', async ({ page }) => {
    // The card is put three seconds out rather than ten minutes, because ten
    // real minutes is not a thing a test may wait for. Everything after the
    // reload is the app: the session finds nothing due, says so, arms its own
    // timer, and picks the card up when it matures.
    await openReview(page);
    const [id] = await seed(page, [{ entry: DASUAN, context: readerContext() }]);
    await page.evaluate(async (cardId: string) => {
      await (window as TangramWindow).__tangram!.repo.grade(cardId, 1, Date.now());
    }, id);
    await setDue(page, id, Date.now() + 3_000);
    await page.reload();

    await expect(page.getByTestId('review-empty')).toHaveText(
      /^Nothing due — 1 card comes back in 1 minute\.$/,
    );
    await expect(page.getByTestId('review-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('card-front')).toContainText('打算');
    // Nothing was reloaded to get here, and nothing was graded either.
    expect(await reviewCount(page, id)).toBe(1);
  });

  test('turning the setting off puts the same grade a day out', async ({ page }) => {
    await openReview(page);
    await page.evaluate(async () => {
      await (window as TangramWindow).__tangram!.repo.setSettings({ shortTermSteps: false });
    });
    const [id] = await seed(page, [{ entry: DASUAN, context: readerContext() }]);

    await page.getByTestId('reveal').click();
    const interval = await page.getByTestId('grade-1').getAttribute('data-interval');
    expect(interval).toMatch(/^\d+(\.\d)?(d|mo|y)$/);
    await page.getByTestId('grade-1').click();

    await expect(page.getByTestId('review-empty')).toHaveText(
      /^Nothing due — next card in \d+ (hours?|days?)\.$/,
    );
    const stored = await storedCard(page, id);
    expect(stored!.due - Date.now()).toBeGreaterThanOrEqual(DAY_MS - 60_000);
  });
});
