import { describe, expect, it } from 'vitest';

import {
  FSRS_PARAMETERS,
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
  it('schedules at least a day for every rating (enable_short_term: false)', () => {
    expect(FSRS_PARAMETERS.enable_short_term).toBe(false);
    for (const rating of RATINGS) {
      const { next } = gradeCard(newCard(NOW), rating, NOW);
      expect(next.due - NOW).toBeGreaterThanOrEqual(DAY);
      expect(next.reps).toBe(1);
      expect(next.last_review).toBe(NOW);
    }
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
    const first = gradeCard(newCard(NOW), 3, NOW).next;
    const lapsed = gradeCard(first, 1, NOW + 5 * DAY).next;
    expect(lapsed.lapses).toBe(1);
  });
});

describe('previewGrades', () => {
  it('offers all four buttons with the interval each would schedule', () => {
    const preview = previewGrades(newCard(NOW), NOW);
    expect(preview.map((item) => item.rating)).toEqual([1, 2, 3, 4]);
    for (const item of preview) {
      expect(item.scheduledDays).toBeGreaterThanOrEqual(1);
      expect(item.due).toBeGreaterThan(NOW);
    }
  });
});

describe('the ms/Date boundary', () => {
  it('round-trips a card without losing anything', () => {
    const graded = gradeCard(newCard(NOW), 2, NOW).next;
    expect(toStoredCard(toFsrsCard(graded))).toEqual(graded);
  });
});
