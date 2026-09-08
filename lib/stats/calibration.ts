/**
 * Calibration: what FSRS predicted against what actually happened (Phase 8).
 *
 * For every review the scheduler had a number — the probability it would be
 * recalled at that moment, off the forgetting curve for the card's stability
 * and the time elapsed since its last review. The outcome was binary. Bucket
 * the predictions into deciles and a well-fitted scheduler's observed rate in
 * each bucket sits on the diagonal: of the reviews it called 80%, about 80%
 * came back. A bow above the line means it is pessimistic (intervals could be
 * longer); below, optimistic (you are forgetting more than it thinks).
 *
 * **This is the chart that says whether optimizing the weights helped**, so
 * three things are deliberate:
 *
 * 1. The prediction is recomputed here from the weights *currently in force*,
 *    not read from a review row. Nothing stored a prediction, and it is the
 *    right choice anyway: after the optimizer writes a new fit, the question is
 *    "how would today's parameters have scored my history", and the answer has
 *    to be recomputed to mean that. It also means a fit that hurt shows up as a
 *    chart that leaves the diagonal.
 * 2. The same denominator as true retention — reviews of cards already in the
 *    Review state. A learning-step review's "stability" is minutes old and its
 *    prediction is ~1.0 by construction; a few hundred of those would pile into
 *    the top decile and flatter the chart into meaninglessness.
 * 3. A bucket under `MIN_CALIBRATION_BUCKET_REVIEWS` is **not drawn**, and the
 *    reviews in it are reported rather than dropped. Three reviews can only
 *    ever observe 0%, 33%, 67% or 100%, none of which is near a prediction of
 *    85%, so plotting it would draw a scheduler that looks broken.
 *
 * The forgetting curve comes from `ts-fsrs` itself (`forgetting_curve`) so this
 * file cannot drift from the scheduler's own maths, and the weights come from
 * `lib/srs/params.ts` — the one construction site (CLAUDE.md). This module
 * never calls `fsrs()` or `generatorParameters()`.
 */

import { forgetting_curve } from 'ts-fsrs';

import type { ReviewRow } from '@/lib/db/schema';
import { isRecalled, isRetentionReview } from '@/lib/stats/retention';
import {
  MIN_CALIBRATION_BUCKET_REVIEWS,
  MIN_CALIBRATION_REVIEWS,
} from '@/lib/stats/thresholds';

const DAY_MS = 86_400_000;

/** Ten deciles: `[0,0.1)`, … , `[0.9,1]`. */
export const CALIBRATION_BUCKET_COUNT = 10;

/**
 * Days between the card's previous review and this one.
 *
 * From `before.last_review` rather than `log.elapsed_days`, and fractionally:
 * `ts-fsrs` rounds the stored elapsed days to whole days, which is a rounding
 * the schedule can live with and a prediction cannot — a card answered 14 hours
 * after a 10-minute step is not "0 days elapsed", and the curve at t=0 is
 * exactly 1.0. The stored integer is the fallback for a row whose `before` has
 * no `last_review` (a card graded for the first time — which this module has
 * already excluded, but the fallback costs nothing and keeps the function total).
 */
export function elapsedDaysOf(review: ReviewRow): number | null {
  const last = review.before.last_review;
  if (typeof last === 'number' && Number.isFinite(last)) {
    return Math.max(0, (review.reviewedAt - last) / DAY_MS);
  }
  const stored = review.log.elapsed_days;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) return stored;
  return null;
}

/**
 * The recall probability FSRS would put on this review under `w`, or null when
 * the row cannot support one (not a Review-state card, no stability, no elapsed
 * time). Null is "not evidence", never 0 — a zero would be a prediction of
 * certain failure and would bend the chart.
 */
export function predictedRecall(review: ReviewRow, w: readonly number[]): number | null {
  if (!isRetentionReview(review)) return null;
  const stability = review.before.stability;
  if (!Number.isFinite(stability) || stability <= 0) return null;
  const elapsed = elapsedDaysOf(review);
  if (elapsed === null) return null;
  const predicted = forgetting_curve(w, elapsed, stability);
  if (!Number.isFinite(predicted)) return null;
  return Math.min(1, Math.max(0, predicted));
}

export interface CalibrationBucket {
  /** 0–9. Bucket `i` holds predictions in `[i/10, (i+1)/10)`; 9 includes 1.0. */
  index: number;
  lower: number;
  upper: number;
  count: number;
  /** Mean prediction of the reviews in the bucket — the dot's x. */
  predictedMean: number;
  /** Share of them actually recalled — the dot's y. */
  observed: number;
  /** False when the bucket is too thin to draw. */
  enough: boolean;
}

export interface CalibrationSummary {
  /** All ten, empty ones included, so a table view can show the whole scale. */
  buckets: CalibrationBucket[];
  /** The ones with enough reviews to plot. */
  drawn: CalibrationBucket[];
  /** Reviews that produced a prediction. */
  used: number;
  /** Review-state reviews that could not (no stability, no elapsed time). */
  unusable: number;
  /** Reviews sitting in buckets too thin to draw — reported, not dropped. */
  thin: number;
  /** Mean prediction and mean outcome over `used`; null when there are none. */
  predictedMean: number | null;
  observedMean: number | null;
  /** `observedMean − predictedMean`: positive means FSRS is under-predicting. */
  bias: number | null;
  enough: boolean;
  needed: number;
  minBucketReviews: number;
}

export interface CalibrationOptions {
  needed?: number;
  minBucketReviews?: number;
}

export function calibration(
  reviews: readonly ReviewRow[],
  w: readonly number[],
  options: CalibrationOptions = {},
): CalibrationSummary {
  const needed = options.needed ?? MIN_CALIBRATION_REVIEWS;
  const minBucketReviews = options.minBucketReviews ?? MIN_CALIBRATION_BUCKET_REVIEWS;

  const counts = new Array<number>(CALIBRATION_BUCKET_COUNT).fill(0);
  const recalls = new Array<number>(CALIBRATION_BUCKET_COUNT).fill(0);
  const sums = new Array<number>(CALIBRATION_BUCKET_COUNT).fill(0);

  let used = 0;
  let unusable = 0;
  let predictedTotal = 0;
  let observedTotal = 0;

  for (const review of reviews) {
    if (!isRetentionReview(review)) continue;
    const predicted = predictedRecall(review, w);
    if (predicted === null) {
      unusable += 1;
      continue;
    }
    // A prediction of exactly 1.0 belongs to the top bucket, not an eleventh.
    const index = Math.min(CALIBRATION_BUCKET_COUNT - 1, Math.floor(predicted * CALIBRATION_BUCKET_COUNT));
    counts[index] += 1;
    sums[index] += predicted;
    const recalled = isRecalled(review);
    if (recalled) recalls[index] += 1;
    used += 1;
    predictedTotal += predicted;
    if (recalled) observedTotal += 1;
  }

  const buckets: CalibrationBucket[] = counts.map((count, index) => ({
    index,
    lower: index / CALIBRATION_BUCKET_COUNT,
    upper: (index + 1) / CALIBRATION_BUCKET_COUNT,
    count,
    // An empty bucket's dot is never drawn; the midpoint keeps the type total
    // rather than leaking a NaN into a chart coordinate.
    predictedMean: count > 0 ? sums[index] / count : (index + 0.5) / CALIBRATION_BUCKET_COUNT,
    observed: count > 0 ? recalls[index] / count : 0,
    enough: count >= minBucketReviews,
  }));

  const drawn = buckets.filter((bucket) => bucket.enough);
  const thin = buckets.reduce((total, bucket) => total + (bucket.enough ? 0 : bucket.count), 0);
  const predictedMean = used > 0 ? predictedTotal / used : null;
  const observedMean = used > 0 ? observedTotal / used : null;

  return {
    buckets,
    drawn,
    used,
    unusable,
    thin,
    predictedMean,
    observedMean,
    bias: predictedMean === null || observedMean === null ? null : observedMean - predictedMean,
    enough: used >= needed && drawn.length > 0,
    needed,
    minBucketReviews,
  };
}
