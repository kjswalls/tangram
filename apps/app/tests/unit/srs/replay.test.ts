import { afterEach, describe, expect, it } from 'vitest';

import { replayCard } from '@/lib/srs/card';
import { DASUAN, freshRepository } from '../db/fixtures';

const DAY = 86_400_000;
let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

/**
 * PLAN.md §3.3: the stored card is a cache of its review history. If replay ever
 * disagrees with what is stored, the reviews table has stopped being the source
 * of truth and a future Supabase migration would silently change schedules.
 */
describe('FSRS replay', () => {
  it('reproduces the stored card state from the review rows alone', async () => {
    const { db, repo } = freshRepository();
    close = () => db.close();

    const start = Date.UTC(2026, 5, 1, 9);
    const card = await repo.addCardFromEntry(DASUAN);

    let latest = card;
    const ratings = [3, 4, 2, 1, 3] as const;
    for (const [index, rating] of ratings.entries()) {
      ({ card: latest } = await repo.grade(card.id, rating, start + index * 4 * DAY));
    }

    const reviews = (await db.reviews.where('cardId').equals(card.id).sortBy('reviewedAt')).map(
      (row) => ({ rating: row.rating, reviewedAt: row.reviewedAt }),
    );
    expect(reviews).toHaveLength(ratings.length);

    const replayed = replayCard(reviews);
    expect(replayed).not.toBeNull();
    expect(replayed?.state).toBe(latest.fsrs.state);
    expect(replayed?.reps).toBe(latest.fsrs.reps);
    expect(replayed?.lapses).toBe(latest.fsrs.lapses);
    expect(replayed?.stability).toBeCloseTo(latest.fsrs.stability, 4);
    expect(replayed?.difficulty).toBeCloseTo(latest.fsrs.difficulty, 4);
    expect(replayed?.due).toBe(latest.fsrs.due);
    expect(replayed?.last_review).toBe(latest.fsrs.last_review);
  });

  it('has nothing to replay for a card that was never graded', () => {
    expect(replayCard([])).toBeNull();
  });
});
