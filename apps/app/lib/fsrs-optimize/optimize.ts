/**
 * The fit itself: coordinate descent over the 21 FSRS weights, and the gate
 * that decides whether the result is allowed anywhere near the learner.
 *
 * `ts-fsrs` ships **no optimizer** — `clipParameters` and `checkParameters` are
 * validation, not training — so this is ours. It is deliberately the dull kind:
 * one weight at a time, a shrinking step, accept an improvement and move on.
 * At a few hundred to a few thousand reviews the whole search is under three
 * hundred replays of the log, which is a second or two of arithmetic; a clever
 * optimizer would buy nothing here and would be much harder to be sure of.
 *
 * ## The safety rule
 *
 * This is the phase's equivalent of the grounding rule and it is not negotiable:
 *
 * 1. The log is split **chronologically** (`dataset.ts`) — never randomly, which
 *    would let the fit see the future of the very cards it is scored on.
 * 2. The search sees the **train half only**. Held-out reviews are scored, never
 *    fitted.
 * 3. A fit is **offered only if it beats what is already in force on the
 *    held-out half by more than the noise in that measurement**, and only if it
 *    also beats the population defaults by the same standard. Both, because
 *    "better than my last fit" and "better than stock FSRS" are different
 *    claims and the learner is entitled to both.
 *
 *    The measurement is a *paired* per-review comparison with a standard error
 *    (`pairedImprovement`, loss.ts), and the gate is `mean − 1.645 × SE > 0` —
 *    a one-sided 95% margin. The bare `<` this used to be was close to a coin
 *    flip: twenty-four review logs generated **from the population defaults
 *    themselves**, where the only correct answer is "nothing to find", got a
 *    fit offered in nine of them, each one an improvement inside one and a bit
 *    standard errors of zero and some of them as far from the true weights as
 *    a different learner's. Under this gate the same twenty-four logs offer
 *    one, at the nominal 5% rate; a log from a genuinely different learner is
 *    still accepted and still lands closer to the truth than the defaults.
 *    `tests/unit/fsrs-optimize/noise-gate.test.ts` runs both.
 * 4. Below `MIN_REVIEWS_FOR_FIT` scorable reviews nothing is offered at all.
 *    The number is a floor for *signal*, not a promise, and it is measured
 *    rather than chosen: see the constant.
 * 5. Nothing is ever applied here. This function returns a result; a person
 *    presses a button.
 */

import { CLAMP_PARAMETERS, W17_W18_Ceiling } from 'ts-fsrs';

import { DEFAULT_SETTINGS, type FsrsWeights, type ReviewRow } from '@/lib/db/schema';
import {
  buildTrainingSet,
  DEFAULT_HOLD_OUT_FRACTION,
  type TrainingSet,
} from '@/lib/fsrs-optimize/dataset';
import {
  logLoss,
  pairedImprovement,
  predict,
  trainLoss,
  type PairedImprovement,
} from '@/lib/fsrs-optimize/loss';
import {
  clipWeights,
  DEFAULT_WEIGHTS,
  resolveWeights,
  type ParameterSettings,
} from '@/lib/srs/params';

/**
 * The floor, in scorable reviews.
 *
 * It was 400 — roughly a month of honest daily study, chosen for being a
 * recognisable amount of work rather than for anything the maths said. At 400
 * the held-out half is 80-odd answers, and that is where the old gate offered
 * noise as a personal fit in 9 of 24 runs on logs generated from the defaults.
 * The significance gate above does most of the work now (1 of 24 on the same
 * logs, which is the 5% it advertises), but the floor was raised with it,
 * measured the same way: at ~1,000 scorable reviews a null log was offered a
 * fit in 0 of 18 runs, while a genuinely different learner was still recovered
 * — accepted in 5 of 18 and landing ~0.4 from the truth where the defaults sit
 * ~0.63 away. Below a thousand this feature has nothing honest to say.
 */
export const MIN_REVIEWS_FOR_FIT = 1000;

/**
 * The step sizes tried, as a fraction of each weight's own *magnitude* — never
 * of its legal range. The ranges are wildly unlike each other (`w0..w3` run to
 * 100, `w12` tops out at 0.25), so a step sized off the range moves the initial
 * stabilities by tens of days and the damping terms by nothing, and the search
 * wanders: an early version of this drifted a long way from weights it should
 * have recovered while barely moving the loss. A fraction of the weight itself
 * is the same relative nudge everywhere.
 */
const STEP_FRACTIONS = [0.3, 0.15, 0.08, 0.04, 0.02, 0.01, 0.005] as const;

/** Sweeps over all 21 weights at one step size before shrinking it. */
const MAX_SWEEPS = 3;

/** How far one coordinate may walk in a single accepted direction. */
const MAX_LINE_STEPS = 6;

/** An improvement smaller than this is noise in the last bits of a double. */
const MIN_IMPROVEMENT = 1e-9;

/**
 * How hard the search is pulled back towards the population defaults.
 *
 * Several of the 21 weights are barely identified by a few thousand reviews:
 * the loss surface is nearly flat along them, so an unpenalised search walks
 * them to their clamp bounds — `w3` pinned at 100 days of initial stability for
 * an Easy — buying a fourth decimal place of training loss and producing a
 * scheduler whose intervals no learner would recognise. This is a ridge penalty
 * in *relative* units (each weight measured against its own default magnitude),
 * mean over the vector, so it costs nothing to move a weight the data actually
 * speaks to and costs a lot to move one it does not.
 *
 * It is applied to the training objective only. Every number reported to the
 * learner, and the gate that decides whether a fit is offered at all, is pure
 * held-out log-loss — a penalty in the score would be marking your own homework.
 */
const RIDGE = 0.05;

export type OptimizeStatus = 'ok' | 'not-enough-data' | 'no-improvement' | 'cancelled';

export interface OptimizeProgress {
  /** Coordinate evaluations done and expected — a progress bar, not a promise. */
  done: number;
  total: number;
  /** The best train-half loss so far. */
  trainLoss: number;
}

export interface OptimizeInput {
  reviews: readonly ReviewRow[];
  /** The settings in force: retention, the short steps, and the weights to beat. */
  settings?: ParameterSettings | null;
  minReviews?: number;
  holdOutFraction?: number;
  signal?: AbortSignal;
  onProgress?: (progress: OptimizeProgress) => void;
  /** Yield after this many coordinate evaluations. */
  yieldEvery?: number;
  /** How to yield. Injected so a test can run the whole search synchronously. */
  yieldTo?: () => Promise<void>;
}

export interface OptimizeResult {
  status: OptimizeStatus;
  /** Scorable reviews — the number the floor is checked against. */
  reviewCount: number;
  /** Every row in the log, including the first-of-a-card ones that cannot be scored. */
  totalReviews: number;
  trainCount: number;
  heldOutCount: number;
  /** Held-out loss of the fitted weights. */
  fittedLoss: number | null;
  /** Held-out loss of the weights currently in force. */
  currentLoss: number | null;
  /** Held-out loss of the population defaults. */
  defaultLoss: number | null;
  /**
   * The fit against the weights in force, and against the defaults: the mean
   * per-review improvement on the held-out half with the standard error of that
   * mean. `lowerBound > 0` on both is the gate; the panel quotes the margin and
   * its uncertainty rather than two bare four-decimal losses.
   */
  improvementOverCurrent: PairedImprovement | null;
  improvementOverDefaults: PairedImprovement | null;
  /** The fitted vector, clipped. Present whenever a search ran. */
  w: number[] | null;
  /** Ready to be written to `settings.fsrsWeights` — only when `status` is 'ok'. */
  fit: FsrsWeights | null;
  /** How many candidate vectors were scored. */
  evaluations: number;
  /** True when the weights in force are already a fit rather than the defaults. */
  currentIsOptimized: boolean;
}

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** The legal range of each weight, from ts-fsrs's own clamp table. */
function bounds(length: number, shortTerm: boolean): [number, number][] {
  return CLAMP_PARAMETERS(W17_W18_Ceiling, shortTerm).slice(0, length) as [number, number][];
}

function empty(
  reason: OptimizeStatus,
  set: TrainingSet,
  currentIsOptimized: boolean,
  evaluations = 0,
): OptimizeResult {
  return {
    status: reason,
    reviewCount: set.scorableReviews,
    totalReviews: set.totalReviews,
    trainCount: set.trainCount,
    heldOutCount: set.heldOutCount,
    fittedLoss: null,
    currentLoss: null,
    defaultLoss: null,
    improvementOverCurrent: null,
    improvementOverDefaults: null,
    w: null,
    fit: null,
    evaluations,
    currentIsOptimized,
  };
}

export async function optimizeWeights(input: OptimizeInput): Promise<OptimizeResult> {
  const settings = input.settings ?? null;
  const shortTerm = settings?.shortTermSteps ?? DEFAULT_SETTINGS.shortTermSteps;
  const current = resolveWeights(settings);
  const set = buildTrainingSet(input.reviews, input.holdOutFraction ?? DEFAULT_HOLD_OUT_FRACTION);
  const floor = input.minReviews ?? MIN_REVIEWS_FOR_FIT;
  const currentIsOptimized = current.source === 'optimized';

  if (set.scorableReviews < floor || set.trainCount === 0 || set.heldOutCount === 0) {
    return empty('not-enough-data', set, currentIsOptimized);
  }
  if (input.signal?.aborted) return empty('cancelled', set, currentIsOptimized);

  // The search starts from the weights in force. Starting from the defaults
  // would throw away a fit that is already good; starting from here means the
  // first candidate is never worse than what the learner has.
  // The prior the ridge pulls towards, and the scale each weight is measured
  // in: its own default magnitude, floored so a default of zero is not a
  // division by zero.
  const prior = clipWeights(DEFAULT_WEIGHTS, settings);
  const priorScale = prior.map((value) => Math.max(Math.abs(value), 0.05));
  const penalty = (w: readonly number[]): number => {
    let total = 0;
    for (let i = 0; i < w.length; i += 1) {
      const diff = (w[i] - prior[i]) / priorScale[i];
      total += diff * diff;
    }
    return (RIDGE * total) / Math.max(1, w.length);
  };
  /** What the search minimises: training log-loss, held near the defaults. */
  const objective = (w: readonly number[]): number => trainLoss(set, w, settings) + penalty(w);

  let best = clipWeights(current.w, settings);
  let bestLoss = objective(best);
  let evaluations = 1;

  const range = bounds(best.length, shortTerm);
  // The floor keeps a weight that has reached zero from having a zero step and
  // being frozen there for the rest of the search.
  const floors = range.map(([min, max]) => Math.max(1e-3, (max - min) * 0.001));
  const yieldEvery = Math.max(1, input.yieldEvery ?? 8);
  const yieldTo = input.yieldTo ?? defaultYield;
  const total = STEP_FRACTIONS.length * best.length;
  let done = 0;
  let sinceYield = 0;

  for (const fraction of STEP_FRACTIONS) {
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
      let improvedThisSweep = false;
      for (let index = 0; index < best.length; index += 1) {
        if (input.signal?.aborted) return empty('cancelled', set, currentIsOptimized, evaluations);
        const [min, max] = range[index] ?? [0, 0];
        const step = fraction * Math.max(Math.abs(best[index]), floors[index]);

        if (step > 0) {
          for (const sign of [1, -1]) {
            let moved = false;
            // Keep walking while the direction keeps paying: one accepted step
            // is usually the start of a slope, and re-scoring from scratch on
            // the next sweep would waste most of the search on rediscovering it.
            for (let walk = 0; walk < MAX_LINE_STEPS; walk += 1) {
              const value = Math.min(max, Math.max(min, best[index] + sign * step));
              if (value === best[index]) break;
              const candidate = [...best];
              candidate[index] = value;
              const clipped = clipWeights(candidate, settings);
              const loss = objective(clipped);
              evaluations += 1;
              if (!Number.isFinite(loss) || loss >= bestLoss - MIN_IMPROVEMENT) break;
              best = clipped;
              bestLoss = loss;
              moved = true;
              improvedThisSweep = true;
            }
            // The other direction is only worth trying if this one went nowhere.
            if (moved) break;
          }
        }

        if (sweep === 0) done += 1;
        sinceYield += 1;
        if (sinceYield >= yieldEvery) {
          sinceYield = 0;
          input.onProgress?.({ done, total, trainLoss: bestLoss });
          await yieldTo();
        }
      }
      if (!improvedThisSweep) break;
    }
  }
  input.onProgress?.({ done: total, total, trainLoss: bestLoss });
  if (input.signal?.aborted) return empty('cancelled', set, currentIsOptimized, evaluations);

  // Scored once, on the half the search never saw — and scored *paired*, review
  // by review against each baseline, because the sign of a difference between
  // two means is not evidence that there is a difference (see `pairedImprovement`).
  const heldOut = [set.splitAt, Number.POSITIVE_INFINITY] as const;
  const fittedPredictions = predict(set, best, settings);
  const currentPredictions = predict(set, current.w, settings);
  const defaultPredictions = currentIsOptimized
    ? predict(set, DEFAULT_WEIGHTS, settings)
    : currentPredictions;

  const fitted = logLoss(fittedPredictions, ...heldOut);
  const currentScore = logLoss(currentPredictions, ...heldOut);
  const defaults = logLoss(defaultPredictions, ...heldOut);

  const overCurrent = pairedImprovement(fittedPredictions, currentPredictions, ...heldOut);
  const overDefaults = currentIsOptimized
    ? pairedImprovement(fittedPredictions, defaultPredictions, ...heldOut)
    : overCurrent;

  const beatsCurrent = Number.isFinite(fitted.loss) && overCurrent.lowerBound > 0;
  const beatsDefaults = Number.isFinite(fitted.loss) && overDefaults.lowerBound > 0;
  const usable = beatsCurrent && beatsDefaults;

  const base: OptimizeResult = {
    status: usable ? 'ok' : 'no-improvement',
    reviewCount: set.scorableReviews,
    totalReviews: set.totalReviews,
    trainCount: set.trainCount,
    heldOutCount: set.heldOutCount,
    fittedLoss: fitted.loss,
    currentLoss: currentScore.loss,
    defaultLoss: defaults.loss,
    improvementOverCurrent: overCurrent,
    improvementOverDefaults: overDefaults,
    w: best,
    fit: null,
    evaluations,
    currentIsOptimized,
  };
  if (!usable) return base;

  return {
    ...base,
    fit: {
      w: best,
      fittedAt: Date.now(),
      reviewCount: set.scorableReviews,
      heldOutLogLoss: fitted.loss,
      // The defaults' loss, per the column's own contract: `isUsableFit` in
      // lib/srs/params.ts re-checks this pair every time the row is read, so a
      // fit that stops beating stock FSRS stops being applied.
      baselineLogLoss: defaults.loss,
    },
  };
}
