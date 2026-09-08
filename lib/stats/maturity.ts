/**
 * Maturity (Phase 8): how much of the collection is actually consolidated.
 *
 * Both numbers come off the repository (`cardCountsByState`,
 * `stabilityHistogram`) — this module only names things, so that a legend and a
 * bar cannot disagree about what they mean. The 21-day edge is
 * `KNOWN_STABILITY_DAYS`, the same threshold the reader paints a word "known"
 * at, which is what makes "growth in known" a thing you can watch here and see
 * in the text you are reading.
 */

import type { CardStateCounts, StabilityBucket } from '@/lib/db/repository';
import { KNOWN_STABILITY_DAYS } from '@/lib/srs/states';

export interface StateTile {
  key: keyof Omit<CardStateCounts, 'total'>;
  label: string;
  /** One line saying what the state is, for the tile's caption. */
  hint: string;
}

/**
 * In the order a card travels, not alphabetically: New → Learning → Review, with
 * Relearning last because it is where a card falls back to.
 */
export const STATE_TILES: readonly StateTile[] = [
  { key: 'new', label: 'New', hint: 'never asked' },
  { key: 'learning', label: 'Learning', hint: 'inside the steps' },
  { key: 'review', label: 'Review', hint: 'on a real interval' },
  { key: 'relearning', label: 'Relearning', hint: 'failed, coming back' },
];

/** Cards whose stability has passed the "known" threshold. */
export function knownCount(buckets: readonly StabilityBucket[]): number {
  return buckets
    .filter((bucket) => bucket.minDays >= KNOWN_STABILITY_DAYS)
    .reduce((total, bucket) => total + bucket.count, 0);
}

/** Cards the histogram covers at all — every state but New. */
export function histogramTotal(buckets: readonly StabilityBucket[]): number {
  return buckets.reduce((total, bucket) => total + bucket.count, 0);
}
