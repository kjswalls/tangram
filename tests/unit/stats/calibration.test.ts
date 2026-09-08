import { describe, expect, it } from 'vitest';

import { buildParameters } from '@/lib/srs/params';
import {
  CALIBRATION_BUCKET_COUNT,
  calibration,
  elapsedDaysOf,
  predictedRecall,
} from '@/lib/stats/calibration';
import { MIN_CALIBRATION_BUCKET_REVIEWS } from '@/lib/stats/thresholds';
import { review } from './fixtures';

const W = buildParameters().w;

/**
 * The synthetic log has a known answer because FSRS's forgetting curve has
 * fixed points we can name: at `elapsed == stability` the curve is the request
 * retention itself (0.90 — decile 9 by construction), and the other two groups
 * were computed from the FSRS-6 power curve, `R = (1 + F·t/S)^-0.1542`:
 *
 *   S = 10, t = 10  → 0.9000  → decile 9
 *   S =  1, t = 1000 → 0.3457 → decile 3
 *   S =  5, t = 60  → 0.6752  → decile 6
 *
 * Nothing here re-derives those numbers from the same code that produces them:
 * the predictions are asserted against the constants, and the bucketing is then
 * asserted against the predictions.
 */
describe('calibration', () => {
  it('puts each review in the decile its predicted recall falls in', () => {
    expect(predictedRecall(review({ stability: 10, elapsedDays: 10 }), W)).toBeCloseTo(0.9, 4);
    expect(predictedRecall(review({ stability: 1, elapsedDays: 1000 }), W)).toBeCloseTo(0.3457, 4);
    expect(predictedRecall(review({ stability: 5, elapsedDays: 60 }), W)).toBeCloseTo(0.6752, 4);
  });

  it('aggregates a log whose answer is known in advance', () => {
    const reviews = [
      // Decile 9: 20 reviews, 18 recalled — exactly on the diagonal.
      ...Array.from({ length: 18 }, () => review({ stability: 10, elapsedDays: 10, rating: 3 })),
      ...Array.from({ length: 2 }, () => review({ stability: 10, elapsedDays: 10, rating: 1 })),
      // Decile 3: 20 reviews, 7 recalled.
      ...Array.from({ length: 7 }, () => review({ stability: 1, elapsedDays: 1000, rating: 2 })),
      ...Array.from({ length: 13 }, () => review({ stability: 1, elapsedDays: 1000, rating: 1 })),
      // Decile 6: 9 reviews — one short of the floor, so it must not be drawn.
      ...Array.from({ length: 6 }, () => review({ stability: 5, elapsedDays: 60, rating: 4 })),
      ...Array.from({ length: 3 }, () => review({ stability: 5, elapsedDays: 60, rating: 1 })),
      // Not evidence: learning-state reviews, and a Review card with no memory.
      ...Array.from({ length: 5 }, () => review({ state: 1, stability: 10, elapsedDays: 1 })),
      review({ stability: 0 }),
    ];

    const summary = calibration(reviews, W, { needed: 40 });

    expect(summary.buckets).toHaveLength(CALIBRATION_BUCKET_COUNT);
    expect(summary.used).toBe(49);
    // The five learning reviews are not "unusable" — they were never eligible.
    expect(summary.unusable).toBe(1);

    const nine = summary.buckets[9];
    expect(nine.count).toBe(20);
    expect(nine.predictedMean).toBeCloseTo(0.9, 4);
    expect(nine.observed).toBeCloseTo(0.9, 10);
    expect(nine.enough).toBe(true);

    const three = summary.buckets[3];
    expect(three.count).toBe(20);
    expect(three.predictedMean).toBeCloseTo(0.3457, 4);
    expect(three.observed).toBeCloseTo(0.35, 10);

    const six = summary.buckets[6];
    expect(six.count).toBe(9);
    expect(six.enough).toBe(false);
    expect(summary.minBucketReviews).toBe(MIN_CALIBRATION_BUCKET_REVIEWS);

    expect(summary.drawn.map((bucket) => bucket.index)).toEqual([3, 9]);
    expect(summary.thin).toBe(9);
    // Every eligible review is either drawn or reported as thin: none vanish.
    expect(summary.drawn.reduce((total, bucket) => total + bucket.count, 0) + summary.thin).toBe(
      summary.used,
    );

    expect(summary.observedMean).toBeCloseTo(31 / 49, 10);
    expect(summary.predictedMean).toBeCloseTo((20 * 0.9 + 20 * 0.3457 + 9 * 0.6752) / 49, 3);
    expect(summary.bias).toBeCloseTo(summary.observedMean! - summary.predictedMean!, 10);
  });

  it('draws nothing until there are enough reviews overall', () => {
    const reviews = Array.from({ length: 50 }, () => review({ stability: 10, elapsedDays: 10 }));
    expect(calibration(reviews, W, { needed: 100 }).enough).toBe(false);
    expect(calibration(reviews, W, { needed: 50 }).enough).toBe(true);
  });

  it('draws nothing when every bucket is too thin, however many reviews there are', () => {
    // 90 reviews, none of them in a bucket that clears the bar: plenty in
    // total, nothing solid anywhere. The count alone must not unlock the chart.
    const reviews = Array.from({ length: 90 }, (_, index) =>
      review({ stability: 10, elapsedDays: 1 + index * 3 }),
    );
    const summary = calibration(reviews, W, { needed: 10, minBucketReviews: 100 });
    expect(summary.used).toBe(90);
    expect(summary.drawn).toHaveLength(0);
    expect(summary.enough).toBe(false);
    expect(summary.thin).toBe(90);
  });

  it('has no prediction for a review the curve cannot speak about', () => {
    expect(predictedRecall(review({ state: 1 }), W)).toBeNull();
    expect(predictedRecall(review({ state: 3 }), W)).toBeNull();
    expect(predictedRecall(review({ stability: 0 }), W)).toBeNull();
    expect(predictedRecall(review({ stability: Number.NaN }), W)).toBeNull();
  });

  it('measures elapsed time from the previous review, fractionally', () => {
    const row = review({ elapsedDays: 0.5 });
    expect(elapsedDaysOf(row)).toBeCloseTo(0.5, 10);
    // `log.elapsed_days` is whole days upstream, and a half-day rounded to zero
    // would predict certain recall (the curve at t=0 is exactly 1).
    expect(row.log.elapsed_days).toBe(1);
    expect(predictedRecall(row, W)).toBeLessThan(1);

    const stored = review({ elapsedDays: 7, noLastReview: true });
    expect(elapsedDaysOf(stored)).toBe(7);
  });

  it('keeps a prediction of exactly 1 in the top decile', () => {
    const summary = calibration([review({ elapsedDays: 0 })], W, { needed: 1, minBucketReviews: 1 });
    expect(summary.buckets[9].count).toBe(1);
    expect(summary.buckets).toHaveLength(10);
  });

  it('is empty, not broken, with no reviews at all', () => {
    const summary = calibration([], W);
    expect(summary.used).toBe(0);
    expect(summary.drawn).toHaveLength(0);
    expect(summary.predictedMean).toBeNull();
    expect(summary.bias).toBeNull();
    expect(summary.enough).toBe(false);
    // Every bucket still carries a finite coordinate, so a chart cannot be
    // asked to plot a NaN.
    for (const bucket of summary.buckets) {
      expect(Number.isFinite(bucket.predictedMean)).toBe(true);
      expect(Number.isFinite(bucket.observed)).toBe(true);
    }
  });

  it('answers with the weights it is given, not a module-level scheduler', () => {
    // Not at `elapsed == stability`, which is the curve's fixed point: FSRS
    // defines its factor so that R(S) is the request retention whatever the
    // decay is, so the one review that could never show a difference is that one.
    const row = review({ stability: 10, elapsedDays: 40 });
    const slower = [...W];
    // w[20] is the FSRS-6 decay: flattening it flattens the curve.
    slower[20] = 0.05;
    expect(predictedRecall(row, slower)).not.toBeCloseTo(predictedRecall(row, W)!, 3);
  });

  it('ignores a review dated before its own previous review', () => {
    const row = review({ elapsedDays: -5 });
    expect(elapsedDaysOf(row)).toBe(0);
    expect(predictedRecall(row, W)).toBe(1);
  });
});
