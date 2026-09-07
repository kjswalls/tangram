/**
 * The FSRS boundary (PLAN.md §3.3).
 *
 * v1 runs `ts-fsrs` with `enable_short_term: false`, so every grade schedules at
 * least a day: a session ends cleanly and "Again" means "tomorrow" rather than
 * "in ninety seconds". Everything crossing this module is epoch ms; `Date`
 * objects exist only inside a call.
 */

import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card as FsrsCard,
  type FSRS,
  type Grade,
  type ReviewLog,
} from 'ts-fsrs';

import type {
  FsrsCardState,
  FsrsStateValue,
  StoredRating,
  StoredReviewLog,
} from '@/lib/db/schema';

/** Frozen for v1 — changing it invalidates every stored schedule. */
export const FSRS_PARAMETERS = { enable_short_term: false } as const;

export const RATINGS: readonly StoredRating[] = [1, 2, 3, 4];

export const RATING_LABELS: Record<StoredRating, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

let scheduler: FSRS | undefined;

/** The one scheduler instance. Cheap to build, but the params must never diverge. */
export function getScheduler(): FSRS {
  return (scheduler ??= fsrs(FSRS_PARAMETERS));
}

/** A brand-new, never-reviewed card. */
export function newCard(now: number = Date.now()): FsrsCardState {
  return toStoredCard(createEmptyCard(new Date(now)));
}

export function toStoredCard(card: FsrsCard): FsrsCardState {
  return {
    state: card.state as FsrsStateValue,
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    ...(card.last_review ? { last_review: card.last_review.getTime() } : {}),
  };
}

export function toFsrsCard(state: FsrsCardState): FsrsCard {
  return {
    state: state.state as State,
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    reps: state.reps,
    lapses: state.lapses,
    scheduled_days: state.scheduled_days,
    learning_steps: state.learning_steps,
    // Deprecated upstream and recomputed by the scheduler from `last_review`;
    // it is never read from storage (§3.3).
    elapsed_days: 0,
    ...(state.last_review === undefined ? {} : { last_review: new Date(state.last_review) }),
  };
}

export function toStoredLog(log: ReviewLog): StoredReviewLog {
  return {
    rating: log.rating as StoredRating,
    state: log.state as FsrsStateValue,
    due: log.due.getTime(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsed_days: log.elapsed_days,
    last_elapsed_days: log.last_elapsed_days,
    scheduled_days: log.scheduled_days,
    learning_steps: log.learning_steps,
    review: log.review.getTime(),
  };
}

export interface GradeResult {
  next: FsrsCardState;
  log: StoredReviewLog;
}

/** Apply a grade. Pure — the repository decides what to persist. */
export function gradeCard(
  state: FsrsCardState,
  rating: StoredRating,
  now: number = Date.now(),
): GradeResult {
  const item = getScheduler().next(toFsrsCard(state), new Date(now), rating as Grade);
  return { next: toStoredCard(item.card), log: toStoredLog(item.log) };
}

export interface GradePreview {
  rating: StoredRating;
  due: number;
  scheduledDays: number;
}

/** What each of the four buttons would schedule, for the interval hints on them. */
export function previewGrades(
  state: FsrsCardState,
  now: number = Date.now(),
): GradePreview[] {
  const preview = getScheduler().repeat(toFsrsCard(state), new Date(now));
  return RATINGS.map((rating) => {
    const item = preview[rating as Grade];
    return {
      rating,
      due: item.card.due.getTime(),
      scheduledDays: item.card.scheduled_days,
    };
  });
}

export interface ReplayReview {
  rating: StoredRating;
  reviewedAt: number;
}

/**
 * Rebuild a card's state from its review history alone (§3.3). The stored card
 * is a cache of this; a unit test asserts the two agree.
 */
export function replayCard(reviews: readonly ReplayReview[]): FsrsCardState | null {
  const history = [...reviews]
    .sort((a, b) => a.reviewedAt - b.reviewedAt)
    .map((review) => ({ rating: review.rating as Grade, review: new Date(review.reviewedAt) }));
  if (history.length === 0) return null;

  const { collections } = getScheduler().reschedule(createEmptyCard(), history, {
    now: new Date(history[history.length - 1].review),
  });
  const last = collections[collections.length - 1];
  return last ? toStoredCard(last.card) : null;
}

export { Rating, State };
