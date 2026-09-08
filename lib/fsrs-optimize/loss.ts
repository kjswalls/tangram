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
    for (const review of sequence) {
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
          out.push({ reviewedAt: review.reviewedAt, p, recalled: review.rating !== 1 });
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
