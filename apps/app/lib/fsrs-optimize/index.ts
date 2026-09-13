/**
 * Personal FSRS parameter optimization (PLAN.md §3.3, Phase 8 item 2).
 *
 * FSRS's whole advantage over a fixed algorithm is that its 21 weights can be
 * fitted to *one* learner's review history. `ts-fsrs` ships the scheduler and
 * not the fit, so the fit is here: `dataset.ts` turns the review log into
 * scorable reviews and splits it chronologically, `loss.ts` replays it through
 * the library's own model and scores it, `optimize.ts` searches and applies the
 * safety rule, `previous.ts` holds the undo.
 *
 * Nothing in here writes anything. `optimizeWeights` returns a result; the
 * settings panel shows both losses and a person presses Apply.
 */

export {
  buildTrainingSet,
  DEFAULT_HOLD_OUT_FRACTION,
  type TrainingReview,
  type TrainingSet,
} from '@/lib/fsrs-optimize/dataset';
export {
  IMPROVEMENT_Z,
  logLoss,
  pairedImprovement,
  predict,
  scoreWeights,
  trainLoss,
  type PairedImprovement,
  type Prediction,
  type Score,
  type SplitScore,
} from '@/lib/fsrs-optimize/loss';
export {
  MIN_REVIEWS_FOR_FIT,
  optimizeWeights,
  type OptimizeInput,
  type OptimizeProgress,
  type OptimizeResult,
  type OptimizeStatus,
} from '@/lib/fsrs-optimize/optimize';
export {
  forgetPrevious,
  parsePrevious,
  previousServerSnapshot,
  previousSnapshot,
  readPrevious,
  rememberPrevious,
  subscribePrevious,
  type PreviousWeights,
} from '@/lib/fsrs-optimize/previous';
