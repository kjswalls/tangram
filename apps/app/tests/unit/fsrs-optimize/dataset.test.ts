import { describe, expect, it } from 'vitest';
import { default_w } from 'ts-fsrs';

import type { ReviewRow, StoredRating } from '@/lib/db/schema';
import { buildTrainingSet } from '@/lib/fsrs-optimize';
import { syntheticReviews } from './synthetic';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

function review(patch: Partial<ReviewRow> & { cardId: string; reviewedAt: number }): ReviewRow {
  const rating = (patch.rating ?? 3) as StoredRating;
  return {
    id: `${patch.cardId}-${patch.reviewedAt}`,
    rating,
    before: {
      state: 2,
      due: patch.reviewedAt,
      stability: 5,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      scheduled_days: 5,
      learning_steps: 0,
    },
    log: {
      rating,
      state: 2,
      due: patch.reviewedAt,
      stability: 5,
      difficulty: 5,
      elapsed_days: 5,
      last_elapsed_days: 5,
      scheduled_days: 5,
      learning_steps: 0,
      review: patch.reviewedAt,
    },
    createdAt: patch.reviewedAt,
    ...patch,
  } as ReviewRow;
}

describe('buildTrainingSet', () => {
  it('groups by card and orders each card chronologically', () => {
    const set = buildTrainingSet([
      review({ cardId: 'a', reviewedAt: START + 3 * DAY }),
      review({ cardId: 'b', reviewedAt: START + DAY }),
      review({ cardId: 'a', reviewedAt: START }),
    ]);
    expect(set.cards).toHaveLength(2);
    const a = set.cards.find((sequence) => sequence[0].cardId === 'a')!;
    expect(a.map((entry) => entry.reviewedAt)).toEqual([START, START + 3 * DAY]);
  });

  it('never scores a card’s first review — there is no memory state to predict from', () => {
    const set = buildTrainingSet([
      review({ cardId: 'a', reviewedAt: START }),
      review({ cardId: 'a', reviewedAt: START + DAY }),
      review({ cardId: 'b', reviewedAt: START + 2 * DAY }),
    ]);
    expect(set.totalReviews).toBe(3);
    // Two firsts, one follow-up.
    expect(set.scorableReviews).toBe(1);
    const a = set.cards.find((sequence) => sequence[0].cardId === 'a')!;
    expect(a.map((entry) => entry.scorable)).toEqual([false, true]);
  });

  it('does not score a same-day review — the curve says "certain" by construction', () => {
    // A learning step taken ten minutes after the last one is `elapsed_days: 0`,
    // where the forgetting curve returns 1. Scoring it charges the model ~13.8
    // nats for every within-session lapse and measures nothing but how badly
    // the session went. It is still replayed: the short-term path is part of
    // how the memory state moves. FSRS's own optimizer excludes them too, and
    // since `shortTermSteps` defaults on there are a lot of them.
    const base = review({ cardId: 'a', reviewedAt: START });
    const sameDay = review({ cardId: 'a', reviewedAt: START + 600_000 });
    // A day after the *step*, which is where the scheduler would put it: the
    // queue never offers a card before its due instant.
    const nextDay = review({ cardId: 'a', reviewedAt: START + 600_000 + DAY });
    const set = buildTrainingSet([
      base,
      { ...sameDay, log: { ...sameDay.log, elapsed_days: 0 } },
      { ...nextDay, log: { ...nextDay.log, elapsed_days: 1 } },
    ]);

    expect(set.totalReviews).toBe(3);
    expect(set.cards[0].map((entry) => entry.scorable)).toEqual([false, false, true]);
    expect(set.scorableReviews).toBe(1);
  });

  /**
   * The reviewer's case, kept permanently.
   *
   * `log.elapsed_days` is `dateDiffInDays` — whole **UTC calendar days** — so a
   * ten-minute learning step at 23:55 → 00:05 is recorded as `1` and used to be
   * scored, against a stability minutes old. That made scorability depend on
   * the hour the learner studies: the same simulated learner at 09:50 handed
   * the objective no within-session steps, and at 23:50 handed it 120 of them
   * (11% of it), moving fitted weights by up to 28%. Scorability is decided
   * from the real gap now, so both learners get the same objective.
   */
  it('does not score a ten-minute step that straddles UTC midnight', () => {
    const midnight = Date.UTC(2026, 0, 2);
    const before = midnight - 5 * 60_000; // 23:55
    const after = midnight + 5 * 60_000; // 00:05, ten minutes later
    const first = review({ cardId: 'a', reviewedAt: before - DAY });
    const step = review({ cardId: 'a', reviewedAt: before });
    const acrossMidnight = review({ cardId: 'a', reviewedAt: after });

    const set = buildTrainingSet([
      { ...first, log: { ...first.log, elapsed_days: 1 } },
      { ...step, log: { ...step.log, elapsed_days: 1 } },
      // What ts-fsrs really writes for 23:55 → 00:05: one calendar day.
      {
        ...acrossMidnight,
        before: { ...acrossMidnight.before, last_review: before },
        log: { ...acrossMidnight.log, elapsed_days: 1 },
      },
    ]);

    const sequence = set.cards[0];
    expect(sequence.map((entry) => entry.elapsedDays)).toEqual([1, 1, 1]);
    // The scheduler's own number says a day; ten minutes of real time say no.
    expect(sequence[2].gapDays).toBeCloseTo(10 / (60 * 24), 6);
    expect(sequence.map((entry) => entry.scorable)).toEqual([false, true, false]);
    expect(set.scorableReviews).toBe(1);
  });

  it('scores from the same clock whatever hour the session runs at', () => {
    // Two identical sessions, one at 09:50 UTC and one at 23:50 UTC: first
    // grade, +1m, +10m, then a real day. The only difference is the wall clock,
    // so the two must produce the same objective.
    const session = (hour: number): ReviewRow[] => {
      const start = Date.UTC(2026, 0, 1, hour, 50);
      const at = [start, start + 60_000, start + 600_000, start + 600_000 + DAY];
      return at.map((reviewedAt, index) => {
        const row = review({ cardId: `h${hour}`, reviewedAt });
        return {
          ...row,
          before: {
            ...row.before,
            ...(index === 0 ? {} : { last_review: at[index - 1] }),
          },
          // The rounded calendar-day difference, exactly as ts-fsrs records it.
          log: {
            ...row.log,
            elapsed_days:
              index === 0
                ? 0
                : Math.floor(at[index] / DAY) - Math.floor(at[index - 1] / DAY),
          },
        };
      });
    };

    const morning = buildTrainingSet(session(9));
    const night = buildTrainingSet(session(23));
    expect(morning.scorableReviews).toBe(1);
    expect(night.scorableReviews).toBe(1);
    expect(night.cards[0].map((entry) => entry.scorable)).toEqual(
      morning.cards[0].map((entry) => entry.scorable),
    );
  });

  it('takes the elapsed days the scheduler recorded, not one it re-derives', () => {
    // `log.elapsed_days` is whole UTC calendar days (ts-fsrs's `dateDiffInDays`),
    // which is what the scheduler used and therefore what the fit must predict
    // under. Two reviews forty hours apart can be one day or two depending on
    // where midnight fell, and only the log knows which.
    const set = buildTrainingSet([
      review({ cardId: 'a', reviewedAt: START }),
      review({
        cardId: 'a',
        reviewedAt: START + 40 * 3_600_000,
        log: { ...review({ cardId: 'a', reviewedAt: 0 }).log, elapsed_days: 2 },
      }),
    ]);
    expect(set.cards[0][1].elapsedDays).toBe(2);
  });

  it('falls back to the stored last_review when a log has no elapsed days', () => {
    const second = review({ cardId: 'a', reviewedAt: START + 3 * DAY + 7_200_000 });
    const set = buildTrainingSet([
      review({ cardId: 'a', reviewedAt: START }),
      {
        ...second,
        before: { ...second.before, last_review: START },
        log: { ...second.log, elapsed_days: Number.NaN },
      },
    ]);
    expect(set.cards[0][1].elapsedDays).toBe(3);
  });

  it('splits chronologically — every training review is older than every held-out one', () => {
    // The rule the whole optimizer rests on. A random split would put a card's
    // later review in train and its earlier one in held-out, and the "held-out"
    // score would be a score on data the fit had already seen the future of.
    const reviews = syntheticReviews({ w: default_w, cards: 40, reviewsPerCard: 6, seed: 4 });
    const set = buildTrainingSet(reviews, 0.2);

    const scorable = set.cards
      .flat()
      .filter((entry) => entry.scorable)
      .map((entry) => entry.reviewedAt);
    const train = scorable.filter((at) => at < set.splitAt);
    const heldOut = scorable.filter((at) => at >= set.splitAt);

    expect(train.length).toBe(set.trainCount);
    expect(heldOut.length).toBe(set.heldOutCount);
    expect(train.length + heldOut.length).toBe(set.scorableReviews);
    expect(Math.max(...train)).toBeLessThan(Math.min(...heldOut));
    // Roughly the fraction asked for, give or take where the boundary lands.
    expect(set.heldOutCount / set.scorableReviews).toBeGreaterThan(0.1);
    expect(set.heldOutCount / set.scorableReviews).toBeLessThan(0.3);
  });

  it('survives an empty log and a log of one review', () => {
    const none = buildTrainingSet([]);
    expect(none.scorableReviews).toBe(0);
    expect(none.trainCount).toBe(0);
    expect(none.heldOutCount).toBe(0);

    const one = buildTrainingSet([review({ cardId: 'a', reviewedAt: START })]);
    expect(one.scorableReviews).toBe(0);
    expect(one.cards).toHaveLength(1);
  });

  it('drops a row with no usable timestamp rather than poisoning the ordering', () => {
    const set = buildTrainingSet([
      review({ cardId: 'a', reviewedAt: START }),
      { ...review({ cardId: 'a', reviewedAt: START + DAY }), reviewedAt: Number.NaN },
      review({ cardId: 'a', reviewedAt: START + 2 * DAY }),
    ]);
    expect(set.totalReviews).toBe(2);
    expect(set.cards[0].every((entry) => Number.isFinite(entry.reviewedAt))).toBe(true);
  });
});
