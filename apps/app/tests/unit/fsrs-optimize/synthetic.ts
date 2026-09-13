/**
 * Review logs generated from *known* FSRS weights, so the optimizer can be
 * asked the only question that really matters: given a history the model
 * actually produced, does the fit move towards the weights that produced it?
 *
 * The generator runs the same machinery the optimizer scores with —
 * `FSRSAlgorithm.next_state` and the exported `forgetting_curve` — because a
 * generator with its own idea of FSRS would be testing the two implementations
 * against each other rather than testing the fit.
 *
 * Everything is seeded. A flaky optimizer test is worse than no optimizer test:
 * it teaches you to re-run rather than to look.
 */

import { forgetting_curve, type FSRSState } from 'ts-fsrs';

import type { ReviewRow, StoredRating } from '@/lib/db/schema';
import { algorithmFor, parametersForWeights, type ParameterSettings } from '@/lib/srs/params';

const DAY_MS = 86_400_000;

/** mulberry32 — 32 bits of state, uniform enough, and identical on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  /** The weights the history is generated from. */
  w: readonly number[];
  cards: number;
  reviewsPerCard: number;
  seed?: number;
  settings?: ParameterSettings | null;
  startAt?: number;
  /** Ratings drawn at random, ignoring the model entirely. */
  noise?: boolean;
  /** Every review gets this rating, whatever the model says. */
  fixedRating?: StoredRating;
  /** Card-id prefix, so two generated logs can be concatenated safely. */
  idPrefix?: string;
}

/** One review row, shaped as the repository writes them. */
function row(
  cardId: string,
  index: number,
  rating: StoredRating,
  reviewedAt: number,
  elapsedDays: number,
  state: FSRSState | null,
): ReviewRow {
  return {
    id: `${cardId}-r${index}`,
    cardId,
    rating,
    reviewedAt,
    before: {
      state: state === null ? 0 : 2,
      due: reviewedAt,
      stability: state?.stability ?? 0,
      difficulty: state?.difficulty ?? 0,
      reps: index,
      lapses: 0,
      scheduled_days: Math.round(elapsedDays),
      learning_steps: 0,
      ...(state === null ? {} : { last_review: reviewedAt - elapsedDays * DAY_MS }),
    },
    log: {
      rating,
      state: state === null ? 0 : 2,
      due: reviewedAt,
      stability: state?.stability ?? 0,
      difficulty: state?.difficulty ?? 0,
      elapsed_days: elapsedDays,
      last_elapsed_days: elapsedDays,
      scheduled_days: Math.round(elapsedDays),
      learning_steps: 0,
      review: reviewedAt,
    },
    createdAt: reviewedAt,
  };
}

/**
 * A review log, chronological across cards.
 *
 * Each card is walked forward: the model says how likely recall is after the
 * gap, a seeded coin decides what actually happened, and the next gap is the
 * interval the same model would have scheduled. Cards are started on staggered
 * days so the log interleaves rather than arriving one card at a time — a
 * chronological split over a log where every card finishes before the next
 * begins would hold out whole cards, which is a different (easier) problem.
 */
export function syntheticReviews(options: SyntheticOptions): ReviewRow[] {
  const params = parametersForWeights(options.w, options.settings);
  const algorithm = algorithmFor(params);
  const random = rng(options.seed ?? 1);
  const start = options.startAt ?? Date.UTC(2025, 0, 1);
  const rows: ReviewRow[] = [];

  for (let c = 0; c < options.cards; c += 1) {
    const cardId = `${options.idPrefix ?? 'card'}-${c}`;
    // Staggered starts, so the log is a stream rather than a concatenation.
    let at = start + Math.floor(random() * options.cards) * DAY_MS;
    let state: FSRSState | null = null;
    let elapsedDays = 0;

    for (let i = 0; i < options.reviewsPerCard; i += 1) {
      let rating: StoredRating;
      if (options.fixedRating !== undefined) {
        rating = options.fixedRating;
      } else if (options.noise) {
        rating = (1 + Math.floor(random() * 4)) as StoredRating;
      } else if (state === null) {
        // The first grade of a card: mostly Good, sometimes harder or easier.
        const roll = random();
        rating = roll < 0.12 ? 1 : roll < 0.3 ? 2 : roll < 0.92 ? 3 : 4;
      } else {
        const p = forgetting_curve(params.w, elapsedDays, state.stability);
        if (random() > p) rating = 1;
        else {
          const roll = random();
          rating = roll < 0.18 ? 2 : roll < 0.9 ? 3 : 4;
        }
      }

      rows.push(row(cardId, i, rating, at, elapsedDays, state));
      state = algorithm.next_state(state, elapsedDays, rating);

      // The gap before the next review is the one this model would schedule,
      // jittered a little the way a person actually turns up.
      const scheduled = options.noise
        ? 1 + Math.floor(random() * 30)
        : Math.max(1, algorithm.next_interval(state.stability, elapsedDays));
      elapsedDays = Math.max(1, Math.round(scheduled * (0.8 + random() * 0.5)));
      at += elapsedDays * DAY_MS;
    }
  }

  return rows.sort((a, b) => a.reviewedAt - b.reviewedAt);
}

/**
 * Distance between two weight vectors, each dimension divided by its own legal
 * range. Raw L2 would be dominated by `w[0..3]` (which run to 100) and blind to
 * `w[12]` (which tops out at 0.25); this asks how far each weight moved *as a
 * fraction of how far it could*.
 */
export function normalizedDistance(
  a: readonly number[],
  b: readonly number[],
  ranges: readonly (readonly [number, number])[],
): number {
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const [min, max] = ranges[i] ?? [0, 1];
    const span = max - min || 1;
    const diff = (a[i] - b[i]) / span;
    total += diff * diff;
  }
  return Math.sqrt(total);
}
