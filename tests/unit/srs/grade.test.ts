import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyCard, fsrs } from 'ts-fsrs';

import { FSRS_PARAMETERS } from '@/lib/srs/card';
import { DASUAN, freshRepository } from '../db/fixtures';

const DAY = 86_400_000;
const START = Date.UTC(2026, 5, 1, 9);

let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

function repo() {
  const { db, repo: repository } = freshRepository();
  close = () => db.close();
  return { db, repo: repository };
}

/**
 * `repository.grade()` is the only writer of a schedule (PLAN.md §3.3): it must
 * move the card *and* append the row that can rebuild it. These tests are the
 * verification of the Phase 0 implementation that P2 was asked to do.
 */
describe('repository.grade', () => {
  it('writes the new state, the mirrored due column, and one review row', async () => {
    const { db, repo: repository } = repo();
    const card = await repository.addCardFromEntry(DASUAN);
    expect(card.fsrs.state).toBe(0);

    const { card: graded, review } = await repository.grade(card.id, 3, START);

    expect(graded.fsrs.state).not.toBe(0);
    expect(graded.due).toBe(graded.fsrs.due);
    expect(graded.updatedAt).toBe(START);
    expect(await db.reviews.count()).toBe(1);

    const stored = await db.cards.get(card.id);
    expect(stored?.fsrs).toEqual(graded.fsrs);
    expect(stored?.due).toBe(graded.due);
    expect(review.cardId).toBe(card.id);
    expect(review.rating).toBe(3);
    expect(review.reviewedAt).toBe(START);
  });

  it('records the state the card was in *before* the grade', async () => {
    const { repo: repository } = repo();
    const card = await repository.addCardFromEntry(DASUAN);

    const first = await repository.grade(card.id, 3, START);
    expect(first.review.before).toEqual(card.fsrs);

    const second = await repository.grade(card.id, 2, START + 5 * DAY);
    expect(second.review.before).toEqual(first.card.fsrs);
    expect(second.review.before).not.toEqual(second.card.fsrs);
  });

  it('stores every date in the review log as epoch ms, never a Date', async () => {
    const { repo: repository } = repo();
    const card = await repository.addCardFromEntry(DASUAN);
    const { review } = await repository.grade(card.id, 4, START);

    for (const key of ['due', 'review'] as const) {
      expect(typeof review.log[key]).toBe('number');
      expect(Number.isFinite(review.log[key])).toBe(true);
    }
    expect(review.log.review).toBe(START);
    expect(review.log.rating).toBe(4);
    // The log carries the pre-grade state, like `before` does.
    expect(review.log.state).toBe(card.fsrs.state);
    expect(typeof review.before.due).toBe('number');
    expect(review.before.last_review).toBeUndefined();
  });

  it('never schedules less than a day, for any rating (enable_short_term: false)', async () => {
    expect(FSRS_PARAMETERS.enable_short_term).toBe(false);
    for (const rating of [1, 2, 3, 4] as const) {
      const { repo: repository } = repo();
      const card = await repository.addCardFromEntry(DASUAN);
      const { card: graded } = await repository.grade(card.id, rating, START);
      expect(graded.due - START).toBeGreaterThanOrEqual(DAY);
      expect(graded.fsrs.scheduled_days).toBeGreaterThanOrEqual(1);
      close?.();
    }
  });

  it('takes a graded card out of the due queue and puts it back when it matures', async () => {
    const { repo: repository } = repo();
    const card = await repository.addCardFromEntry(DASUAN);
    const { card: graded } = await repository.grade(card.id, 3, START);

    expect(await repository.listDue(START)).toHaveLength(0);
    expect(await repository.newCandidates(10)).toHaveLength(0);
    const back = await repository.listDue(graded.due);
    expect(back.map((row) => row.id)).toEqual([card.id]);
  });

  it('refuses to grade a card that is not there', async () => {
    const { repo: repository } = repo();
    await expect(repository.grade('nope', 3, START)).rejects.toThrow(/no card/);
  });
});

/**
 * §3.3: the stored card is a cache of the review history. Replayed straight
 * through `ts-fsrs` — not through our own helper — the rows must rebuild it.
 */
describe('the reviews table is the source of truth', () => {
  it('reproduces the stored card by rescheduling an empty card over the rows', async () => {
    const { db, repo: repository } = repo();
    const card = await repository.addCardFromEntry(DASUAN);

    let latest = card;
    const ratings = [3, 1, 3, 4, 2] as const;
    for (const [index, rating] of ratings.entries()) {
      ({ card: latest } = await repository.grade(card.id, rating, START + index * 6 * DAY));
    }

    const rows = await db.reviews.where('cardId').equals(card.id).sortBy('reviewedAt');
    const history = rows.map((row) => ({ rating: row.rating, review: new Date(row.reviewedAt) }));

    const { collections } = fsrs(FSRS_PARAMETERS).reschedule(createEmptyCard(), history, {
      now: new Date(history[history.length - 1].review),
    });
    const replayed = collections[collections.length - 1].card;

    expect(replayed.state).toBe(latest.fsrs.state);
    expect(replayed.reps).toBe(latest.fsrs.reps);
    expect(replayed.lapses).toBe(latest.fsrs.lapses);
    expect(replayed.stability).toBeCloseTo(latest.fsrs.stability, 6);
    expect(replayed.difficulty).toBeCloseTo(latest.fsrs.difficulty, 6);
    expect(replayed.due.getTime()).toBe(latest.fsrs.due);
    expect(replayed.last_review?.getTime()).toBe(latest.fsrs.last_review);
  });
});
