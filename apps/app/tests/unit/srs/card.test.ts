import { describe, expect, it } from 'vitest';

import {
  gradeCard,
  newCard,
  previewGrades,
  RATINGS,
  toFsrsCard,
  toStoredCard,
} from '@/lib/srs/card';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 7, 12);

describe('newCard', () => {
  it('starts in New, due now, never reviewed', () => {
    const card = newCard(NOW);
    expect(card.state).toBe(0);
    expect(card.due).toBe(NOW);
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
    expect(card.last_review).toBeUndefined();
    // elapsed_days is deprecated upstream and deliberately not stored.
    expect(card).not.toHaveProperty('elapsed_days');
  });
});

describe('gradeCard', () => {
  /**
   * Phase 8 restored ts-fsrs's own default (`settings.shortTermSteps`, true):
   * a new card that is failed comes back inside the session. v1 asserted the
   * opposite here, and that assertion was the deviation, not the rule.
   */
  it('brings a failed new card back inside the day, by default', () => {
    const { next } = gradeCard(newCard(NOW), 1, NOW);
    expect(next.due - NOW).toBeLessThan(DAY);
    expect(next.due).toBeGreaterThan(NOW);
    // 1 is Learning: the state that only exists with the short-term steps on.
    expect(next.state).toBe(1);
    expect(next.reps).toBe(1);
    expect(next.last_review).toBe(NOW);
  });

  it('schedules at least a day for every rating when the steps are off', () => {
    const settings = { shortTermSteps: false };
    for (const rating of RATINGS) {
      const { next } = gradeCard(newCard(NOW), rating, NOW, settings);
      expect(next.due - NOW).toBeGreaterThanOrEqual(DAY);
      expect(next.reps).toBe(1);
      expect(next.last_review).toBe(NOW);
    }
  });

  it('is the settings row that decides, not a constant in this module', () => {
    const short = gradeCard(newCard(NOW), 1, NOW, { shortTermSteps: true }).next;
    const long = gradeCard(newCard(NOW), 1, NOW, { shortTermSteps: false }).next;
    expect(short.due).toBeLessThan(long.due);

    // Higher target retention → shorter intervals for the same answer.
    const eager = gradeCard(newCard(NOW), 4, NOW, { requestRetention: 0.97 }).next;
    const relaxed = gradeCard(newCard(NOW), 4, NOW, { requestRetention: 0.7 }).next;
    expect(eager.due).toBeLessThan(relaxed.due);
  });

  it('orders the four intervals Again ≤ Hard ≤ Good ≤ Easy', () => {
    const dues = RATINGS.map((rating) => gradeCard(newCard(NOW), rating, NOW).next.due);
    expect([...dues].sort((a, b) => a - b)).toEqual(dues);
  });

  it('writes a review log carrying the pre-grade state, as epoch ms', () => {
    const before = newCard(NOW);
    const { log } = gradeCard(before, 3, NOW);
    expect(log.rating).toBe(3);
    expect(log.state).toBe(before.state);
    expect(log.review).toBe(NOW);
    expect(Number.isFinite(log.due)).toBe(true);
  });

  it('counts a lapse when a review card is failed', () => {
    // Easy graduates a new card straight to Review; a lapse is a failure *from*
    // Review, so with the learning steps on (the default) the card has to get
    // out of them first. Good on a new card is a step, not a graduation.
    const first = gradeCard(newCard(NOW), 4, NOW).next;
    expect(first.state).toBe(2);
    const lapsed = gradeCard(first, 1, NOW + 5 * DAY).next;
    expect(lapsed.lapses).toBe(1);
  });
});

describe('previewGrades', () => {
  it('offers all four buttons with the interval each would schedule', () => {
    const preview = previewGrades(newCard(NOW), NOW);
    expect(preview.map((item) => item.rating)).toEqual([1, 2, 3, 4]);
    for (const item of preview) {
      expect(item.due).toBeGreaterThan(NOW);
    }
    // Sorted by how far out they land, whichever unit that is.
    const dues = preview.map((item) => item.due);
    expect([...dues].sort((a, b) => a - b)).toEqual(dues);
  });

  it('previews under the same parameters the grade will use', () => {
    const settings = { shortTermSteps: false };
    const preview = previewGrades(newCard(NOW), NOW, settings);
    for (const item of preview) {
      expect(item.scheduledDays).toBeGreaterThanOrEqual(1);
      expect(gradeCard(newCard(NOW), item.rating, NOW, settings).next.due).toBe(item.due);
    }
  });
});

describe('the ms/Date boundary', () => {
  it('round-trips a card without losing anything', () => {
    const graded = gradeCard(newCard(NOW), 2, NOW).next;
    expect(toStoredCard(toFsrsCard(graded))).toEqual(graded);
  });
});
