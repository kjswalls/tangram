/**
 * The optimizer's input: a review log turned into what FSRS can be scored on.
 *
 * `repo.allReviewsChronological()` is an append-only table of grades. Each row
 * carries the card's state *before* the grade and the `ReviewLog` the scheduler
 * wrote, and it is the log that matters here: `log.elapsed_days` is the delta-t
 * the scheduler itself measured at grade time, in the units it measures in
 * (`dateDiffInDays` — whole UTC calendar days, so two reviews ten minutes apart
 * on the same day are zero days apart and take FSRS's short-term path). Deriving
 * it again from timestamps would be a *different* number, and the whole point of
 * fitting is to predict the scheduler that ran, not a scheduler we invented.
 *
 * Two rules that are not obvious and are load-bearing:
 *
 * 1. **A card's first review is not scorable, and neither is a same-day one.**
 *    The first has no memory state to predict recall from — FSRS *initialises*
 *    the state from that grade. A review at `elapsed_days === 0` is a learning
 *    step taken minutes after the last one, where the forgetting curve says
 *    "certainly remembered" by construction, so scoring it charges the model
 *    ~13.8 nats for every within-session lapse and measures nothing but how
 *    badly the session went. FSRS's own optimizer excludes them for the same
 *    reason. Both kinds are **replayed** — the state has to come from
 *    somewhere, and the short-term path is part of how it moves — and neither
 *    is scored. Since `shortTermSteps` defaults on (Phase 8) this is most of
 *    the difference between a signal and a mood.
 * 2. **The train/held-out split is chronological, never random.** A random
 *    split leaks the future: a card's later review sits in train while its
 *    earlier one sits in held-out, and the fit is scored on reviews it has
 *    already seen the consequences of. The split here is a single instant;
 *    everything before it trains, everything at or after it is held out. A
 *    card's own history still crosses the line, and that is correct — the
 *    memory state at a held-out review is exactly what a learner's card
 *    actually carried into it.
 */

import type { ReviewRow, StoredRating } from '@/lib/db/schema';

/** One review, as the model sees it. */
export interface TrainingReview {
  cardId: string;
  reviewedAt: number;
  rating: StoredRating;
  /** Days since this card's previous review, as the scheduler measured them. */
  elapsedDays: number;
  /** False for a first or same-day review — replayed, never scored. */
  scorable: boolean;
}

export interface TrainingSet {
  /** Per card, chronological. Cards with a single review are still here. */
  cards: TrainingReview[][];
  /** Every row that went in. */
  totalReviews: number;
  /** Rows a prediction can be made for — the number the floor is checked against. */
  scorableReviews: number;
  /** Train is `reviewedAt < splitAt`; held-out is at or after it. */
  splitAt: number;
  trainCount: number;
  heldOutCount: number;
  firstAt: number | null;
  lastAt: number | null;
}

const DAY_MS = 86_400_000;

/** `dateDiffInDays` restated for the fallback path — whole UTC days, floored. */
function utcDayDiff(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.max(0, Math.floor((utcB - utcA) / DAY_MS));
}

/**
 * How long the card had been left, in days.
 *
 * The stored log first, because it is what the scheduler used. A row written by
 * an importer, or one whose log is missing the field, falls back to the same
 * calculation from `before.last_review`, and to zero when there is no previous
 * review to measure from.
 */
function elapsedDaysFor(row: ReviewRow, previousAt: number | null): number {
  const logged = row.log?.elapsed_days;
  if (typeof logged === 'number' && Number.isFinite(logged) && logged >= 0) return logged;
  const last = row.before?.last_review ?? previousAt;
  if (typeof last !== 'number' || !Number.isFinite(last)) return 0;
  return utcDayDiff(last, row.reviewedAt);
}

export const DEFAULT_HOLD_OUT_FRACTION = 0.2;

export function buildTrainingSet(
  reviews: readonly ReviewRow[],
  holdOutFraction: number = DEFAULT_HOLD_OUT_FRACTION,
): TrainingSet {
  const byCard = new Map<string, ReviewRow[]>();
  for (const row of reviews) {
    if (!row || typeof row.reviewedAt !== 'number' || !Number.isFinite(row.reviewedAt)) continue;
    const list = byCard.get(row.cardId);
    if (list) list.push(row);
    else byCard.set(row.cardId, [row]);
  }

  const cards: TrainingReview[][] = [];
  const scorableAt: number[] = [];
  let totalReviews = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const [cardId, rows] of byCard) {
    const ordered = [...rows].sort((a, b) => a.reviewedAt - b.reviewedAt);
    const sequence: TrainingReview[] = [];
    let previousAt: number | null = null;
    for (const row of ordered) {
      const elapsedDays = elapsedDaysFor(row, previousAt);
      const scorable = previousAt !== null && elapsedDays > 0;
      sequence.push({
        cardId,
        reviewedAt: row.reviewedAt,
        rating: row.rating,
        elapsedDays,
        scorable,
      });
      if (scorable) scorableAt.push(row.reviewedAt);
      if (firstAt === null || row.reviewedAt < firstAt) firstAt = row.reviewedAt;
      if (lastAt === null || row.reviewedAt > lastAt) lastAt = row.reviewedAt;
      previousAt = row.reviewedAt;
      totalReviews += 1;
    }
    cards.push(sequence);
  }

  scorableAt.sort((a, b) => a - b);
  const fraction = Math.min(0.9, Math.max(0.05, holdOutFraction));
  // The boundary is the first held-out review's own instant, so no review can
  // land in both halves and the two counts always sum to the whole.
  const index = Math.min(
    scorableAt.length - 1,
    Math.max(1, Math.floor(scorableAt.length * (1 - fraction))),
  );
  const splitAt = scorableAt.length > 1 ? scorableAt[index] : Number.POSITIVE_INFINITY;
  let trainCount = 0;
  let heldOutCount = 0;
  for (const at of scorableAt) {
    if (at < splitAt) trainCount += 1;
    else heldOutCount += 1;
  }

  return {
    cards,
    totalReviews,
    scorableReviews: scorableAt.length,
    splitAt,
    trainCount,
    heldOutCount,
    firstAt,
    lastAt,
  };
}
