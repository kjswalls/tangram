import { afterEach, describe, expect, it } from 'vitest';

import type { CardRow, PhraseToken } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { loadStats } from '@/lib/stats/summary';
import { MIN_RETENTION_REVIEWS } from '@/lib/stats/thresholds';
import { freshRepository } from '../db/fixtures';

const DAY = 86_400_000;
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

const open: { close: () => void }[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function repo(): Repository {
  const { db, repo: repository } = freshRepository();
  open.push(db);
  return repository;
}

const tokens = (text: string): PhraseToken[] => [{ text, entryId: `${text}|${text}[x]` }];

async function phrase(repository: Repository, text: string): Promise<CardRow> {
  return repository.addPhraseCard(tokens(text), `the ${text} one`, {
    source: 'seed',
    addedAt: NOW - 90 * DAY,
  });
}

/**
 * `loadStats` over a real repository rather than a fixture array: the numbers
 * on `/stats` are only true if the queries prep added return what the panels
 * think they do, and the only way to know that is to grade real cards.
 *
 * The history: four cards graduated with Easy 60 days ago (Easy on a New card
 * goes straight to Review, so everything after it is a retention review); three
 * of them answered Good at −40 and −10 days; the fourth failed at −3.
 */
async function history(repository: Repository): Promise<void> {
  for (const text of ['一', '二', '三']) {
    const card = await phrase(repository, text);
    await repository.grade(card.id, 4, NOW - 60 * DAY);
    await repository.grade(card.id, 3, NOW - 40 * DAY);
    await repository.grade(card.id, 3, NOW - 10 * DAY);
  }
  const lapsed = await phrase(repository, '四');
  await repository.grade(lapsed.id, 4, NOW - 60 * DAY);
  await repository.grade(lapsed.id, 1, NOW - 3 * DAY);
}

describe('loadStats', () => {
  it('splits the window from all time without re-deriving either', async () => {
    const repository = repo();
    await history(repository);

    const stats = await loadStats({ repo: repository, now: NOW });

    // 11 rows in the log: four graduations plus seven real reviews.
    expect(stats.totalReviews).toBe(11);

    // All time: 7 reviews of Review-state cards, 6 recalled. The four Easy
    // grades were of New cards and are excluded — and counted.
    expect(stats.retentionAllTime.reviews).toBe(7);
    expect(stats.retentionAllTime.recalled).toBe(6);
    expect(stats.retentionAllTime.excluded).toBe(4);
    expect(stats.retentionAllTime.rate).toBeCloseTo(6 / 7, 10);

    // The last 30 days sees only the −10 and −3 grades.
    expect(stats.retentionWindow.reviews).toBe(4);
    expect(stats.retentionWindow.recalled).toBe(3);
    expect(stats.retentionWindow.rate).toBe(0.75);

    // Both are far under the floor, so neither is shown as a rate.
    expect(stats.retentionAllTime.enough).toBe(false);
    expect(stats.retentionWindow.enough).toBe(false);
    expect(stats.retentionWindow.needed).toBe(MIN_RETENTION_REVIEWS);

    // The bar chart covers the same window: every review inside it, this time
    // including the learning-state ones (there are none in this window).
    const bars = stats.reviewsPerDay.reduce((sum, day) => sum + day.count, 0);
    expect(bars).toBe(4);
    expect(stats.reviewsPerDay).toHaveLength(30);
    expect(stats.windowStart).toBe(stats.reviewsPerDay[0].start);
  });

  it('forecasts every scheduled card once and no new one at all', async () => {
    const repository = repo();
    await history(repository);
    // A card that was never graded: it has a due instant and is not a debt.
    await phrase(repository, '五');

    const stats = await loadStats({ repo: repository, now: NOW });

    expect(stats.states.total).toBe(5);
    expect(stats.states.new).toBe(1);
    expect(stats.states.review).toBe(3);
    expect(stats.states.relearning).toBe(1);

    expect(stats.forecast.counted + stats.forecast.beyond).toBe(4);
    const drawn = stats.forecast.days.reduce((sum, day) => sum + day.count, 0);
    expect(drawn).toBe(stats.forecast.counted);
  });

  it('reads the histogram and the known count off the same buckets', async () => {
    const repository = repo();
    await history(repository);

    const stats = await loadStats({ repo: repository, now: NOW });
    const total = stats.stability.reduce((sum, bucket) => sum + bucket.count, 0);
    // Every card but the New ones is in a bucket, and there are none here.
    expect(total).toBe(stats.states.total - stats.states.new);
    expect(stats.known).toBeLessThanOrEqual(total);
    expect(stats.known).toBe(
      stats.stability
        .filter((bucket) => bucket.minDays >= 21)
        .reduce((sum, bucket) => sum + bucket.count, 0),
    );
  });

  it('is honest, not broken, on a database with nothing in it', async () => {
    const stats = await loadStats({ repo: repo(), now: NOW });

    expect(stats.totalReviews).toBe(0);
    expect(stats.retentionWindow.rate).toBeNull();
    expect(stats.retentionWindow.enough).toBe(false);
    expect(stats.calibration.enough).toBe(false);
    expect(stats.calibration.used).toBe(0);
    expect(stats.workloadPeak).toBe(0);
    expect(stats.states.total).toBe(0);
    expect(stats.known).toBe(0);
    expect(stats.reviewsPerDay).toHaveLength(30);
    expect(stats.forecast.days).toHaveLength(30);
    // The parameters line is still answerable: the panel says which weights
    // these (absent) predictions would have been made with.
    expect(stats.parameters).toBe('FSRS defaults');
  });

  it('honours a shorter window without touching the definition of one', async () => {
    const repository = repo();
    await history(repository);

    const stats = await loadStats({ repo: repository, now: NOW, windowDays: 7 });
    expect(stats.reviewsPerDay).toHaveLength(7);
    expect(stats.forecast.days).toHaveLength(7);
    // Only the −3 day grade is inside a week.
    expect(stats.retentionWindow.reviews).toBe(1);
    expect(stats.retentionWindow.recalled).toBe(0);
  });
});
