/**
 * Reader / known states (PLAN.md §3.3). Unit-tested, because these three
 * thresholds are what colour every token in the reader and every row in a list.
 */

import type { FsrsCardState } from '@/lib/db/schema';
import type { HskBand } from '@/lib/types';
import { State, toFsrsCard, toStoredCard } from '@/lib/srs/card';

export type WordState = 'new' | 'learning' | 'known';

/** A Review card at or above this stability counts as known. */
export const KNOWN_STABILITY_DAYS = 21;

/** Stability written by "Mark known": far past the known threshold, and not due. */
export const MARK_KNOWN_STABILITY_DAYS = 365;

const DAY_MS = 86_400_000;

export interface WordStateInput {
  /** The card for this entry, if one exists. */
  card?: Pick<FsrsCardState, 'state' | 'stability'> | null;
  /** True when the entry is in `known_words`. */
  known?: boolean;
  hskBand?: HskBand;
  /** `settings.knownBand` — bands at or below it are assumed known. */
  knownBand: HskBand;
}

export function wordState({ card, known, hskBand, knownBand }: WordStateInput): WordState {
  if (known) return 'known';
  if (hskBand !== undefined && hskBand <= knownBand) return 'known';
  if (!card) return 'new';
  // States 0/1/3 are New, Learning and Relearning; 2 is Review.
  if (card.state !== 2) return 'learning';
  return card.stability >= KNOWN_STABILITY_DAYS ? 'known' : 'learning';
}

/**
 * The FSRS state "Mark known" writes onto an existing card: Review, comfortably
 * above the known threshold, and out of the queue for a year.
 */
export function knownCardState(
  previous: FsrsCardState,
  now: number = Date.now(),
): FsrsCardState {
  const due = now + MARK_KNOWN_STABILITY_DAYS * DAY_MS;
  return toStoredCard({
    ...toFsrsCard(previous),
    state: State.Review,
    stability: Math.max(previous.stability, MARK_KNOWN_STABILITY_DAYS),
    difficulty: previous.difficulty || 5,
    scheduled_days: MARK_KNOWN_STABILITY_DAYS,
    due: new Date(due),
    last_review: new Date(now),
  });
}
