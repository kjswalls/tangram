/**
 * What "these weights are better" means, and the only place it is computed.
 *
 * The model is replayed, not re-derived. `algorithmFor(parametersForWeights(w))`
 * is `ts-fsrs`'s own `FSRSAlgorithm`, so `next_state` here is character-for-
 * character the update the scheduler performs when it grades a card, and the
 * predicted recall comes from the library's exported **`forgetting_curve`**
 * (`forgetting_curve(w, elapsedDays, stability)` — the parameter-vector
 * overload, which reads the FSRS-6 decay out of `w[20]` rather than assuming
 * one). Re-deriving either formula would produce an optimizer that fits a
 * model the app does not run.
 *
 * The objective is binary log-loss of predicted recall against what happened:
 * Again is "forgot", Hard/Good/Easy are "recalled" — the same three-into-one
 * that every FSRS optimizer uses, because FSRS models *whether* the card came
 * back, and Hard-but-remembered is remembered.
 */

import { forgetting_curve, S_MAX, S_MIN, type FSRSState } from 'ts-fsrs';

import { algorithmFor, parametersForWeights, type ParameterSettings } from '@/lib/srs/params';
import type { TrainingReview, TrainingSet } from '@/lib/fsrs-optimize/dataset';

/** One scorable review, with what the model expected of it. */
export interface Prediction {
  /**
   * The card, and the review's position in that card's own sequence. Together
   * they name the review across two replays, which is what lets one weight
   * vector be compared with another **on the same reviews**
   * (`pairedImprovement`) rather than through two independently-taken means.
   */
  cardId: string;
  index: number;
  reviewedAt: number;
  /** Predicted probability of recall, in (0, 1). */
  p: number;
  /** What happened: anything but Again. */
  recalled: boolean;
}

/**
 * Probabilities are clamped before the logarithm. A model that is certain and
 * wrong would otherwise contribute an infinite loss and every comparison after
 * it would be `NaN`-poisoned; this bounds one review's contribution at ~13.8.
 */
const P_MIN = 1e-6;
const P_MAX = 1 - 1e-6;

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** A memory state the model can be stepped from, or null if it has gone bad. */
function sane(state: FSRSState): FSRSState | null {
  if (!Number.isFinite(state.stability) || !Number.isFinite(state.difficulty)) return null;
  return {
    stability: clamp(state.stability, S_MIN, S_MAX),
    difficulty: clamp(state.difficulty, 1, 10),
  };
}

/**
 * Replay every card under one weight vector and collect what it predicted.
 *
 * A card whose replay throws (`next_state` validates its inputs) or goes
 * non-finite is abandoned from that point on rather than allowed to poison the
 * total: a degenerate candidate should score badly, not score `NaN`, because
 * `NaN < best` is false and a silent one would end the search at whatever
 * happened to come first.
 */
export function predict(
  set: TrainingSet,
  w: readonly number[],
  settings?: ParameterSettings | null,
): Prediction[] {
  const params = parametersForWeights(w, settings);
  const algorithm = algorithmFor(params);
  const out: Prediction[] = [];

  for (const sequence of set.cards) {
    let state: FSRSState | null = null;
    for (let index = 0; index < sequence.length; index += 1) {
      const review = sequence[index];
      try {
        if (state === null) {
          // The first grade initialises the state; nothing to predict from yet.
          state = sane(algorithm.next_state(null, 0, review.rating));
          if (state === null) break;
          continue;
        }
        const p = clamp(
          forgetting_curve(params.w, review.elapsedDays, state.stability),
          P_MIN,
          P_MAX,
        );
        if (!Number.isFinite(p)) break;
        // Replayed either way; scored only when the dataset says it carries
        // information (not a first review, not a same-day learning step).
        if (review.scorable) {
          out.push({
            cardId: review.cardId,
            index,
            reviewedAt: review.reviewedAt,
            p,
            recalled: review.rating !== 1,
          });
        }
        state = sane(algorithm.next_state(state, review.elapsedDays, review.rating, p));
        if (state === null) break;
      } catch {
        // A candidate the library itself refuses. Stop this card, keep the rest.
        break;
      }
    }
  }
  return out;
}

export interface Score {
  /** Mean binary log-loss. Lower is better; `Infinity` when nothing was scored. */
  loss: number;
  count: number;
}

/** Log-loss over the predictions inside `[from, to)`. Half-open, so windows tile. */
export function logLoss(
  predictions: readonly Prediction[],
  from: number = Number.NEGATIVE_INFINITY,
  to: number = Number.POSITIVE_INFINITY,
): Score {
  let total = 0;
  let count = 0;
  for (const prediction of predictions) {
    if (prediction.reviewedAt < from || prediction.reviewedAt >= to) continue;
    total += prediction.recalled ? -Math.log(prediction.p) : -Math.log(1 - prediction.p);
    count += 1;
  }
  if (count === 0) return { loss: Number.POSITIVE_INFINITY, count: 0 };
  const loss = total / count;
  return { loss: Number.isFinite(loss) ? loss : Number.POSITIVE_INFINITY, count };
}

/**
 * How much better one vector is than another, **and how sure of it we are**.
 *
 * Two mean log-losses can be compared with `<`, and that is what the gate used
 * to do. It is close to a coin flip on a small held-out slice: a review log
 * generated *from the population defaults themselves* — where the right answer
 * is always "nothing to find" — produced a fit that beat the defaults on
 * held-out in nine of twenty-four runs at the old floor, with the improvement
 * every time inside one and a bit standard errors of zero. A sign is not
 * evidence; a margin measured against its own noise is.
 *
 * The reviews are the same reviews on both sides, so the difference is taken
 * **per review and then averaged** — a paired comparison. That removes the
 * variance of the reviews themselves (a held-out slice full of hard cards is
 * hard for both vectors) and leaves the variance of the difference, which is
 * the thing the gate is actually uncertain about.
 */
export interface PairedImprovement {
  /** Mean per-review loss the candidate saves. Positive means it is better. */
  mean: number;
  /** Standard error of that mean, over the paired differences. */
  standardError: number;
  count: number;
  /**
   * The low end of the one-sided 95% interval, `mean − 1.645 × SE`. Above zero
   * is "better than this baseline by more than the noise in the measurement".
   */
  lowerBound: number;
}

/** One-sided 95%. Normal rather than t: the counts here are in the hundreds. */
export const IMPROVEMENT_Z = 1.645;

/** What a review costs when a vector could not model it at all (see `predict`). */
const MAX_LOSS = -Math.log(P_MIN);

const key = (prediction: Prediction): string => `${prediction.cardId}#${prediction.index}`;

const lossOf = (prediction: Prediction): number =>
  prediction.recalled ? -Math.log(prediction.p) : -Math.log(1 - prediction.p);

/**
 * Paired per-review improvement of `candidate` over `baseline` inside
 * `[from, to)`.
 *
 * A review one side abandoned (a degenerate candidate stops replaying a card)
 * is charged that side the worst a single prediction can cost, so refusing to
 * model a review can never look like an improvement.
 */
export function pairedImprovement(
  candidate: readonly Prediction[],
  baseline: readonly Prediction[],
  from: number = Number.NEGATIVE_INFINITY,
  to: number = Number.POSITIVE_INFINITY,
): PairedImprovement {
  const inWindow = (prediction: Prediction): boolean =>
    prediction.reviewedAt >= from && prediction.reviewedAt < to;
  const candidateLoss = new Map<string, number>();
  const baselineLoss = new Map<string, number>();
  for (const prediction of candidate) {
    if (inWindow(prediction)) candidateLoss.set(key(prediction), lossOf(prediction));
  }
  for (const prediction of baseline) {
    if (inWindow(prediction)) baselineLoss.set(key(prediction), lossOf(prediction));
  }

  const differences: number[] = [];
  for (const id of new Set([...candidateLoss.keys(), ...baselineLoss.keys()])) {
    differences.push((baselineLoss.get(id) ?? MAX_LOSS) - (candidateLoss.get(id) ?? MAX_LOSS));
  }

  const count = differences.length;
  if (count === 0) return { mean: 0, standardError: Number.POSITIVE_INFINITY, count: 0, lowerBound: Number.NEGATIVE_INFINITY };

  const mean = differences.reduce((total, value) => total + value, 0) / count;
  if (count < 2) {
    return { mean, standardError: Number.POSITIVE_INFINITY, count, lowerBound: Number.NEGATIVE_INFINITY };
  }
  // Sample variance (n − 1), then the standard error of the mean.
  const variance =
    differences.reduce((total, value) => total + (value - mean) * (value - mean), 0) / (count - 1);
  const standardError = Math.sqrt(Math.max(0, variance) / count);
  if (!Number.isFinite(mean) || !Number.isFinite(standardError)) {
    return { mean, standardError: Number.POSITIVE_INFINITY, count, lowerBound: Number.NEGATIVE_INFINITY };
  }
  return { mean, standardError, count, lowerBound: mean - IMPROVEMENT_Z * standardError };
}

/** The two halves of the split, scored in one replay. */
export interface SplitScore {
  train: Score;
  heldOut: Score;
}

export function scoreWeights(
  set: TrainingSet,
  w: readonly number[],
  settings?: ParameterSettings | null,
): SplitScore {
  const predictions = predict(set, w, settings);
  return {
    train: logLoss(predictions, Number.NEGATIVE_INFINITY, set.splitAt),
    heldOut: logLoss(predictions, set.splitAt, Number.POSITIVE_INFINITY),
  };
}

/** Train-half loss alone — what the search minimises, and all it may see. */
export function trainLoss(
  set: TrainingSet,
  w: readonly number[],
  settings?: ParameterSettings | null,
): number {
  return logLoss(predict(set, w, settings), Number.NEGATIVE_INFINITY, set.splitAt).loss;
}

export type { TrainingReview };
