/**
 * True retention (Phase 8): of the reviews of cards that were **already in the
 * Review state**, the share graded Hard, Good or Easy rather than Again.
 *
 * The denominator is the whole point. A learning-step review is a card you are
 * still meeting for the first time — under FSRS's own learning steps a new word
 * can be answered three times in ten minutes — so counting those reviews mixes
 * "did the schedule work" with "how many times did I press a button just now",
 * and the second one drowns the first. Every SRS that reports one number gets
 * this wrong at least once; here the excluded reviews are counted and shown, so
 * the number on screen can be checked against the number of rows in the table.
 *
 * Hard (2) counts as recalled. FSRS treats Again as the only failure — Hard is
 * a hit that cost something, and it is what the scheduler's own forgetting
 * curve is fitted against, so counting it as a miss would report a retention
 * the algorithm is not aiming for.
 */

import type { FsrsStateValue, ReviewRow } from '@/lib/db/schema';
import { MIN_RETENTION_REVIEWS } from '@/lib/stats/thresholds';

/** The stored `ts-fsrs` `State.Review`. The only state this counts. */
export const REVIEW_STATE: FsrsStateValue = 2;

/** A review of a card that was in the Review state when it was asked. */
export function isRetentionReview(review: ReviewRow): boolean {
  return review.before.state === REVIEW_STATE;
}

/** Again (1) is the only failure; Hard, Good and Easy are all recalls. */
export function isRecalled(review: ReviewRow): boolean {
  return review.rating > 1;
}

export interface RetentionSummary {
  /** Reviews that count: the denominator, stated on screen. */
  reviews: number;
  /** Of those, the ones not graded Again. */
  recalled: number;
  /** `recalled / reviews`, or null when there is nothing to divide. */
  rate: number | null;
  /** Reviews looked at and left out because the card was not in Review yet. */
  excluded: number;
  /** Every review in the window, counted or not. */
  considered: number;
  /** False while `reviews` is under the floor: the panel says so instead. */
  enough: boolean;
  /** The floor in force, so the empty state can name it. */
  needed: number;
}

/**
 * `reviews` is any set of review rows — all time, or a window. The caller does
 * the windowing, because the dashboard shows two spans of the same function and
 * they must not be able to disagree about what a retention review is.
 */
export function trueRetention(
  reviews: readonly ReviewRow[],
  needed: number = MIN_RETENTION_REVIEWS,
): RetentionSummary {
  let counted = 0;
  let recalled = 0;
  for (const review of reviews) {
    if (!isRetentionReview(review)) continue;
    counted += 1;
    if (isRecalled(review)) recalled += 1;
  }
  return {
    reviews: counted,
    recalled,
    rate: counted > 0 ? recalled / counted : null,
    excluded: reviews.length - counted,
    considered: reviews.length,
    enough: counted >= needed,
    needed,
  };
}

/** `0.9412` → `94%`. Whole points: the third digit is noise at any real N. */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}
