/**
 * How long a session will take (docs/plans/core.md C8).
 *
 * C8's Today sentence ends "About six minutes." and the plan is explicit about
 * where that number may come from: **it does not exist and must not be
 * invented** — derive it from the learner's own median seconds per review once
 * there are reviews, and fall back to one named constant before that, with the
 * constant and its provenance written down.
 *
 * So:
 *
 * - The review log (`allReviewsChronological()`) records `reviewedAt` and
 *   nothing else — there is no stored duration — so a review's cost is the gap
 *   to the review before it. That is the honest reading of the data we keep,
 *   and it measures the thing the learner feels: how long a card took,
 *   including thinking about it.
 * - **The median, not the mean.** One review with a twenty-minute gap in front
 *   of it is a learner who made a cup of tea, and a mean would let that one gap
 *   decide the estimate.
 * - **Gaps longer than `SESSION_GAP_MS` are not reviews**, they are the
 *   boundary between two sittings, and they are dropped rather than clamped:
 *   clamping a fifty-minute gap to five minutes still says the learner spent
 *   five minutes on one card.
 * - **`DEFAULT_SECONDS_PER_REVIEW` is a placeholder, and it is labelled as one
 *   in the code rather than dressed up as a measurement.** It is the order of
 *   magnitude a short vocabulary review takes — press a key, read a word — and
 *   it exists only until the learner has done `MIN_SAMPLES` reviews of their
 *   own. It is not from a study and this comment does not pretend it is.
 *
 * Nothing here is shown to a tenth of a minute. `estimateMinutes` rounds, and
 * `describeMinutes` says "About a minute" rather than "0 minutes" — a false
 * precision on a guess is worse than the guess.
 */

/** A gap longer than this separates two sittings; it is not one review. */
export const SESSION_GAP_MS = 5 * 60_000;

/** Below this many usable gaps, the learner's own pace is not yet a number. */
export const MIN_SAMPLES = 10;

/**
 * The placeholder pace, in seconds per item. See the header: it is an order of
 * magnitude, not a measurement, and it is replaced by the learner's own median
 * as soon as there are `MIN_SAMPLES` gaps to take one from.
 */
export const DEFAULT_SECONDS_PER_REVIEW = 8;

export interface PacedReview {
  reviewedAt: number;
}

/**
 * The learner's median seconds per review, or `undefined` while there is not
 * enough of their own history to say.
 */
export function medianSecondsPerReview(
  reviews: readonly PacedReview[],
): number | undefined {
  const gaps: number[] = [];
  for (let index = 1; index < reviews.length; index += 1) {
    const gap = reviews[index].reviewedAt - reviews[index - 1].reviewedAt;
    // Zero and negative gaps are a seeded or replayed log, not a fast learner.
    if (gap > 0 && gap <= SESSION_GAP_MS) gaps.push(gap);
  }
  if (gaps.length < MIN_SAMPLES) return undefined;
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0 ? (gaps[middle - 1] + gaps[middle]) / 2 : gaps[middle];
  return median / 1000;
}

/** Minutes for `items` at `seconds` each, rounded, never below one. */
export function estimateMinutes(items: number, seconds: number): number {
  if (items <= 0) return 0;
  return Math.max(1, Math.round((items * seconds) / 60));
}

const WORDS = [
  'zero', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve',
] as const;

/**
 * "About six minutes." — the sentence's last clause.
 *
 * Small numbers are words because the sentence in front of them is a sentence,
 * and "About 6 minutes" reads like a receipt. Above twelve it is a numeral,
 * which is where spelling numbers out starts costing more than it buys.
 */
export function describeMinutes(minutes: number): string {
  if (minutes <= 0) return '';
  if (minutes === 1) return 'About a minute.';
  const value = minutes < WORDS.length ? WORDS[minutes] : String(minutes);
  return `About ${value} minutes.`;
}
