import { expect, test } from '@playwright/test';

import {
  DASUAN,
  KANKAN,
  openReview,
  readerContext,
  reviewRows,
  seed,
  SENTENCE,
  storedCard,
} from './fixtures';

const DAY_MS = 86_400_000;

/**
 * PLAN.md §4, P2. Every card here is seeded through `window.__tangram.repo`
 * (`components/shell/test-hooks.tsx`) — the app is local-first, so the database
 * is the fixture.
 */
test.describe('/review', () => {
  test('walks the due queue: flip, four intervals, grade with 1–4, one review row', async ({
    page,
  }) => {
    await openReview(page);
    // Graded a month ago, so both are genuinely past due now.
    const [first] = await seed(page, [
      { entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 },
      { entry: KANKAN, context: readerContext({ source: 'lookup' }), gradedDaysAgo: 20 },
    ]);

    await expect(page.getByTestId('review-progress')).toHaveText('Card 1 of 2');
    await expect(page.getByTestId('card-front')).toContainText('打算');
    await expect(page.getByTestId('card-back')).toHaveCount(0);

    // A key that means nothing here does nothing.
    await page.keyboard.press('x');
    await expect(page.getByTestId('card-back')).toHaveCount(0);

    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('card-pinyin')).toHaveText('dǎsuàn');
    await expect(page.getByTestId('card-back')).toContainText('HSK 2');

    // Each button says what it would schedule, and nothing is under a day.
    for (const [rating, label] of [
      [1, 'Again'],
      [2, 'Hard'],
      [3, 'Good'],
      [4, 'Easy'],
    ] as const) {
      const button = page.getByTestId(`grade-${rating}`);
      await expect(button).toContainText(label);
      const interval = await button.getAttribute('data-interval');
      expect(interval).toMatch(/^\d+(\.\d)?(d|mo|y)$/);
    }

    await page.keyboard.press('3');

    // The grade persisted as its own review row — the seed's backdated grade is
    // the other one — and the card is rescheduled forward from this instant.
    await expect(page.getByTestId('review-progress')).toHaveText('Card 2 of 2');
    const rows = (await reviewRows(page)).filter((row) => row.cardId === first);
    expect(rows).toHaveLength(2);
    const latest = rows[rows.length - 1];
    expect(latest.rating).toBe(3);
    expect(latest.before.state).toBe(2);
    expect(latest.log.review).toBe(latest.reviewedAt);

    const stored = await storedCard(page, first);
    expect(stored?.due).toBeGreaterThanOrEqual(latest.reviewedAt + DAY_MS);
    expect(stored?.fsrs.reps).toBe(2);
  });

  test('a grade survives a reload: the next card is up and the graded one is gone', async ({
    page,
  }) => {
    await openReview(page);
    const [first, second] = await seed(page, [
      { entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 },
      { entry: KANKAN, context: readerContext({ source: 'lookup' }), gradedDaysAgo: 20 },
    ]);

    await expect(page.getByTestId('review-card')).toHaveAttribute('data-card-id', first);
    await page.getByTestId('reveal').click();
    await page.getByTestId('grade-3').click();
    await expect(page.getByTestId('review-card')).toHaveAttribute('data-card-id', second);

    await page.reload();

    const card = page.getByTestId('review-card');
    await expect(card).toHaveAttribute('data-card-id', second);
    await expect(card).toContainText('看看');
    await expect(card).not.toContainText('打算');
    // A fresh session, so the counter starts over on what is left.
    await expect(page.getByTestId('review-progress')).toHaveText('Card 1 of 1');
    // One row per grade: the graded card has the seed's plus this one, the card
    // that was never reached still has only the seed's.
    const rows = await reviewRows(page);
    expect(rows.filter((row) => row.cardId === first)).toHaveLength(2);
    expect(rows.filter((row) => row.cardId === second)).toHaveLength(1);
  });

  test('a card with context carries its sentence: masked on the front, marked on the back', async ({
    page,
  }) => {
    await openReview(page);
    await seed(page, [{ entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 }]);

    await page.getByTestId('peek-context').click();
    const peek = page.getByTestId('context-peek');
    await expect(peek).toHaveText('我＿＿明天去北京。');
    await expect(peek).not.toContainText('打算');

    await page.keyboard.press('Space');
    await expect(page.getByTestId('context-back')).toHaveText(SENTENCE);
    await expect(page.getByTestId('context-target')).toHaveText('打算');
    await expect(page.getByTestId('card-back')).toContainText('From the sentence');
  });

  test('the chosen sense leads and the rest fold away', async ({ page }) => {
    await openReview(page);
    await seed(page, [
      {
        entry: DASUAN,
        context: readerContext({ source: 'ask', question: 'how do I say I plan to?' }),
        senseIndex: 1,
        gradedDaysAgo: 30,
      },
    ]);

    await page.keyboard.press('Space');
    await expect(page.getByTestId('card-glosses')).toHaveText('to intend');
    const others = page.getByTestId('other-senses');
    await expect(others).toContainText('Other senses (2)');
    await others.click();
    await expect(others).toContainText('to plan');
  });

  test('the empty state says when the next card is due', async ({ page }) => {
    await openReview(page);
    // Graded just now, so it is scheduled forward and nothing is due.
    await seed(page, [{ entry: DASUAN, context: readerContext(), gradedDaysAgo: 0 }]);

    await expect(page.getByTestId('review-card')).toHaveCount(0);
    await expect(page.getByTestId('review-empty')).toHaveText(
      /^Nothing due — next card in \d+ (hours?|days?)\.$/,
    );
  });

  test('the empty state says so when nothing is scheduled at all', async ({ page }) => {
    await openReview(page);
    await page.reload();
    await expect(page.getByTestId('review-empty')).toHaveText(
      'Nothing due — no cards are scheduled yet.',
    );
  });

  test('an explicitly added New card is in today’s queue', async ({ page }) => {
    // §3.3: an Add from lookup/ask/reader is always offered, cap or no cap.
    await openReview(page);
    await seed(page, [{ entry: KANKAN, context: readerContext({ source: 'lookup' }) }]);

    await expect(page.getByTestId('review-card')).toContainText('看看');
    await page.keyboard.press('Space');
    await page.keyboard.press('1');
    await expect(page.getByTestId('review-empty')).toBeVisible();

    const rows = await reviewRows(page);
    expect(rows).toHaveLength(1);
    // Even "Again" is a day out, so the session ends rather than looping.
    expect(rows[0].before.state).toBe(0);
    const stored = await storedCard(page, rows[0].cardId);
    expect(stored?.due).toBeGreaterThanOrEqual(rows[0].reviewedAt + DAY_MS);
  });
});
