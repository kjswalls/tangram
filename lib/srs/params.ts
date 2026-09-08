/**
 * The FSRS parameter object — the one place it is built (Phase 8 prep).
 *
 * Everything that schedules anything goes through here: grading, the four
 * interval previews, the replay that rebuilds a card from its review rows, and
 * whatever the optimizer scores its candidate weights with. Nothing else in the
 * app may call `fsrs()` or `generatorParameters()` — a second construction site
 * is a second set of parameters, and two schedulers that disagree produce a
 * card whose stored schedule its own history cannot reproduce.
 *
 * Three things come out of the settings row and nothing else does:
 *
 * - `request_retention` — the recall probability FSRS aims for at review time.
 * - `enable_short_term` (+ the learning steps that go with it) — v1 shipped
 *   this *off*, which was a deliberate deviation from ts-fsrs's own default so
 *   a session would end cleanly. `settings.shortTermSteps` now defaults TRUE,
 *   which undoes it: a failed new card comes back in a minute, not tomorrow.
 * - `w` — the learner's own fitted weights when there are some that hold up,
 *   the population defaults otherwise.
 *
 * The weights are validated here rather than trusted, because `ts-fsrs` fails
 * quietly in both directions: a vector of the wrong length is swapped for the
 * defaults with a `console` warning and no signal a caller can see, and a
 * vector full of `NaN` is *clamped to 0.001* and used, which would schedule
 * every card in the database wrong forever. A stored fit that does not hold up
 * is ignored and `describeParameters()` says so.
 */

import {
  clipParameters,
  default_w,
  fsrs,
  FSRSAlgorithm,
  generatorParameters,
  type FSRS,
  type FSRSParameters,
  type StepUnit,
} from 'ts-fsrs';

import { DEFAULT_SETTINGS, type FsrsWeights, type SettingsRow } from '@/lib/db/schema';

/**
 * What this module needs off a settings row. A `Partial` of the three columns
 * rather than the row itself, so a caller holding nothing (a test, the
 * optimizer scoring a candidate) can pass `undefined` and get the defaults.
 */
export type ParameterSettings = Partial<
  Pick<SettingsRow, 'requestRetention' | 'shortTermSteps' | 'fsrsWeights'>
>;

/**
 * The retention range the UI offers. Below 0.70 FSRS's own interval maths gets
 * unstable and the learner is forgetting a third of everything; above 0.97 the
 * review count runs away for a gain nobody can feel.
 */
export const MIN_REQUEST_RETENTION = 0.7;
export const MAX_REQUEST_RETENTION = 0.97;

/**
 * The steps the settings control offers across that range. A slider of 27
 * one-point stops would suggest a precision the algorithm does not have; these
 * are the values that make a difference a learner can feel.
 */
export const RETENTION_CHOICES: readonly number[] = [0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.95, 0.97];

/** The steps `ts-fsrs` itself defaults to, spelled out rather than implied. */
export const LEARNING_STEPS: readonly StepUnit[] = ['1m', '10m'];
export const RELEARNING_STEPS: readonly StepUnit[] = ['10m'];

/**
 * FSRS 4, 5 and 6 take 17, 19 and 21 weights. `ts-fsrs` 5.4.2 is FSRS-6, so a
 * fresh fit here is 21 long; the shorter vectors are accepted because the
 * library still upgrades them, and refusing one would silently discard a fit a
 * previous build wrote.
 */
export const VALID_WEIGHT_LENGTHS: readonly number[] = [17, 19, 21];

/** The population defaults, for anything that wants to compare against them. */
export const DEFAULT_WEIGHTS: readonly number[] = default_w;

export type WeightsSource = 'default' | 'optimized';

export interface ResolvedWeights {
  w: readonly number[];
  source: WeightsSource;
  /** The stored fit, when it is the one in force. */
  fit: FsrsWeights | null;
  /** True when a fit was stored and was thrown out for not being usable. */
  rejected: boolean;
}

/**
 * Is this something `ts-fsrs` can be handed? Length is the library's rule;
 * finiteness is ours, and it is the one that matters — `generatorParameters`
 * clamps a `NaN` into 0.001 and schedules with it.
 */
export function isValidWeightVector(w: unknown): w is number[] {
  return (
    Array.isArray(w) &&
    VALID_WEIGHT_LENGTHS.includes(w.length) &&
    w.every((value) => typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Is a stored fit usable *and* worth using? A fit that scored no better than
 * the population defaults on the reviews it was not fitted on is overfitting
 * with extra steps, so it is stored (the dashboard should be able to say so)
 * and not applied.
 */
export function isUsableFit(fit: FsrsWeights | null | undefined): fit is FsrsWeights {
  if (!fit || !isValidWeightVector(fit.w)) return false;
  if (!Number.isFinite(fit.heldOutLogLoss) || !Number.isFinite(fit.baselineLogLoss)) return false;
  return fit.heldOutLogLoss < fit.baselineLogLoss;
}

export function resolveWeights(settings?: ParameterSettings | null): ResolvedWeights {
  const fit = settings?.fsrsWeights ?? null;
  if (isUsableFit(fit)) return { w: fit.w, source: 'optimized', fit, rejected: false };
  return { w: DEFAULT_WEIGHTS, source: 'default', fit: null, rejected: fit !== null };
}

/** The requested retention, held inside the range the UI offers. */
export function clampRetention(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.requestRetention;
  }
  return Math.min(MAX_REQUEST_RETENTION, Math.max(MIN_REQUEST_RETENTION, value));
}

/** The parameter object itself. Pure — same settings in, same object out. */
export function buildParameters(settings?: ParameterSettings | null): FSRSParameters {
  const shortTerm = settings?.shortTermSteps ?? DEFAULT_SETTINGS.shortTermSteps;
  return generatorParameters({
    request_retention: clampRetention(settings?.requestRetention),
    enable_short_term: shortTerm,
    // Not applied at all when `enable_short_term` is false, and spelled out
    // anyway: the pair is one decision and reading it in one place is the
    // point of this module.
    learning_steps: [...LEARNING_STEPS],
    relearning_steps: [...RELEARNING_STEPS],
    w: resolveWeights(settings).w,
  });
}

/**
 * A candidate weight vector, held inside the bounds `ts-fsrs` will accept.
 *
 * `clipParameters` is the library's own clamp — the same table
 * (`CLAMP_PARAMETERS`) the scheduler validates against — so a vector that has
 * been through it can never be one `fsrs()` rejects or silently rewrites. It
 * also launders `NaN`: the clamp reads a non-finite entry as 0 and pins it to
 * the bound, which is exactly the failure `isValidWeightVector` exists to catch
 * and is why this is not the place to trust an input either. A vector of the
 * wrong length is not clippable at all and falls back to the defaults.
 *
 * The relearning-step count is `RELEARNING_STEPS.length`, because the ceiling
 * `clipParameters` puts on w17/w18 depends on how many steps a lapse walks —
 * pass the wrong number and the clamp is for a different app.
 */
export function clipWeights(
  w: readonly number[],
  settings?: ParameterSettings | null,
): number[] {
  if (!Array.isArray(w) || !VALID_WEIGHT_LENGTHS.includes(w.length)) {
    return [...DEFAULT_WEIGHTS];
  }
  const shortTerm = settings?.shortTermSteps ?? DEFAULT_SETTINGS.shortTermSteps;
  const clipped = clipParameters([...w], RELEARNING_STEPS.length, shortTerm);
  return isValidWeightVector(clipped) ? clipped : [...DEFAULT_WEIGHTS];
}

/**
 * The parameter object for a *candidate* vector — the optimizer's scoring path.
 *
 * `buildParameters` resolves the weights off the settings row, and deliberately
 * refuses a stored fit that has not proved itself; a fit cannot prove itself
 * without being scored first, so scoring needs a way in that is not the stored
 * column. Everything else about the parameters (retention, the short steps) is
 * still read from the settings, so a candidate is scored under the scheduler
 * the learner actually runs.
 */
export function parametersForWeights(
  w: readonly number[],
  settings?: ParameterSettings | null,
): FSRSParameters {
  const shortTerm = settings?.shortTermSteps ?? DEFAULT_SETTINGS.shortTermSteps;
  return generatorParameters({
    request_retention: clampRetention(settings?.requestRetention),
    enable_short_term: shortTerm,
    learning_steps: [...LEARNING_STEPS],
    relearning_steps: [...RELEARNING_STEPS],
    w: clipWeights(w, settings),
  });
}

/**
 * The bare FSRS memory model behind a parameter object: `next_state` and the
 * forgetting curve, without the card, the learning steps or the clock.
 *
 * It lives here for the same reason `fsrs()` does — one construction site — and
 * it exists at all because the optimizer replays a review log through the model
 * thousands of times and has no use for a schedule while doing it.
 */
export function algorithmFor(params: FSRSParameters): FSRSAlgorithm {
  return new FSRSAlgorithm(params);
}

/**
 * Scheduler instances, memoised on the parameters they were built from.
 *
 * Building one is cheap but not free, and `previewGrades` runs on every render
 * of a card; keying the cache on the parameters (rather than holding one
 * instance, as v1 did) is what lets the settings change mid-session without
 * anything having to remember to invalidate.
 */
const schedulers = new Map<string, FSRS>();

/** The most parameter sets worth holding: current, previous, and slack. */
const SCHEDULER_CACHE_LIMIT = 8;

function cacheKey(params: FSRSParameters): string {
  return JSON.stringify([
    params.request_retention,
    params.enable_short_term,
    params.learning_steps,
    params.relearning_steps,
    params.w,
  ]);
}

export function schedulerFor(params: FSRSParameters): FSRS {
  const key = cacheKey(params);
  const hit = schedulers.get(key);
  if (hit) return hit;
  if (schedulers.size >= SCHEDULER_CACHE_LIMIT) schedulers.clear();
  const built = fsrs(params);
  schedulers.set(key, built);
  return built;
}

/** The scheduler these settings imply. The only `fsrs()` call in the app. */
export function getScheduler(settings?: ParameterSettings | null): FSRS {
  return schedulerFor(buildParameters(settings));
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `3 Mar` — the day the fit was made, in the browser's own timezone. */
function shortDate(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'an unknown date';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** `1,240`, grouped the same way on every machine — no locale in the loop. */
function grouped(value: number): string {
  const whole = Math.max(0, Math.trunc(value));
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One line naming which weights are in force, for the settings pane and for
 * anywhere else that would otherwise have to guess.
 */
export function describeParameters(settings?: ParameterSettings | null): string {
  const resolved = resolveWeights(settings);
  if (resolved.source === 'optimized' && resolved.fit) {
    return `Optimized from your ${grouped(resolved.fit.reviewCount)} ${
      resolved.fit.reviewCount === 1 ? 'review' : 'reviews'
    } on ${shortDate(resolved.fit.fittedAt)}`;
  }
  if (resolved.rejected) {
    const fit = settings?.fsrsWeights ?? null;
    if (fit && isValidWeightVector(fit.w)) {
      // Stored, readable, and no better than the defaults on held-out reviews.
      return 'FSRS defaults — your last fit did not beat them';
    }
    return 'FSRS defaults — the saved weights were not usable';
  }
  return 'FSRS defaults';
}
