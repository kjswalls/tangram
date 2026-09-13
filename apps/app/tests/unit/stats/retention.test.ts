import { describe, expect, it } from 'vitest';

import { formatRate, isRetentionReview, trueRetention } from '@/lib/stats/retention';
import { MIN_RETENTION_REVIEWS } from '@/lib/stats/thresholds';
import { review } from './fixtures';

/**
 * True retention's denominator is the whole claim: reviews of cards that were
 * already in the Review state. With FSRS's learning steps on (the default since
 * Phase 8) a new card can be answered three times in ten minutes, almost always
 * successfully, so folding those in walks the headline number up toward 95% and
 * stops it responding to the schedule at all.
 */
describe('true retention', () => {
  it('counts only reviews of cards already in the Review state', () => {
    const reviews = [
      review({ state: 2, rating: 3 }),
      review({ state: 2, rating: 1 }),
      // Learning, Relearning and New reviews: real rows, wrong question.
      review({ state: 1, rating: 3 }),
      review({ state: 1, rating: 1 }),
      review({ state: 3, rating: 3 }),
      review({ state: 0, rating: 4 }),
    ];

    const summary = trueRetention(reviews, 1);
    expect(summary.reviews).toBe(2);
    expect(summary.recalled).toBe(1);
    expect(summary.rate).toBe(0.5);
    expect(summary.excluded).toBe(4);
    expect(summary.considered).toBe(6);
  });

  it('would report a different number if learning reviews were counted', () => {
    // The regression this denominator exists to prevent, made explicit: the
    // same rows, counted the other way, read 83% instead of 50%.
    const reviews = [
      review({ state: 2, rating: 3 }),
      review({ state: 2, rating: 1 }),
      review({ state: 1, rating: 3 }),
      review({ state: 1, rating: 3 }),
      review({ state: 1, rating: 3 }),
      review({ state: 1, rating: 3 }),
    ];
    const summary = trueRetention(reviews, 1);
    expect(summary.rate).toBe(0.5);

    const naive = reviews.filter((row) => row.rating > 1).length / reviews.length;
    expect(naive).toBeCloseTo(5 / 6, 10);
    expect(summary.rate).not.toBeCloseTo(naive, 2);
  });

  it('treats Again as the only failure', () => {
    const reviews = [1, 2, 3, 4].map((rating) =>
      review({ state: 2, rating: rating as 1 | 2 | 3 | 4 }),
    );
    const summary = trueRetention(reviews, 1);
    // Hard is a hit that cost something — it is what FSRS fits its curve
    // against, so scoring it as a miss reports a retention nothing aims for.
    expect(summary.recalled).toBe(3);
    expect(summary.rate).toBe(0.75);
  });

  it('has no rate at all when nothing qualifies', () => {
    const summary = trueRetention([review({ state: 1 }), review({ state: 0 })], 1);
    expect(summary.reviews).toBe(0);
    expect(summary.rate).toBeNull();
    expect(formatRate(summary.rate)).toBe('—');
    expect(summary.enough).toBe(false);
  });

  it('is not enough until the floor is reached, and then it is', () => {
    const under = Array.from({ length: MIN_RETENTION_REVIEWS - 1 }, () => review({ state: 2 }));
    expect(trueRetention(under).enough).toBe(false);
    expect(trueRetention(under).needed).toBe(MIN_RETENTION_REVIEWS);

    const at = [...under, review({ state: 2 })];
    expect(at).toHaveLength(MIN_RETENTION_REVIEWS);
    expect(trueRetention(at).enough).toBe(true);
  });

  it('does not let a pile of learning reviews reach the floor', () => {
    const learning = Array.from({ length: MIN_RETENTION_REVIEWS * 3 }, () => review({ state: 1 }));
    const summary = trueRetention(learning);
    expect(summary.considered).toBe(MIN_RETENTION_REVIEWS * 3);
    expect(summary.enough).toBe(false);
  });

  it('names a retention review the same way everywhere', () => {
    expect(isRetentionReview(review({ state: 2 }))).toBe(true);
    expect(isRetentionReview(review({ state: 3 }))).toBe(false);
  });

  it('rounds to whole points', () => {
    expect(formatRate(0.9412)).toBe('94%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(null)).toBe('—');
  });
});
