/**
 * The gate that decides whether a fit is offered at all — and the attack that
 * showed the old one was close to a coin flip.
 *
 * The rule used to be a bare comparison of two mean held-out log-losses
 * (`fitted.loss < currentScore.loss`). Reviewed at its own floor of 400
 * scorable reviews — where the held-out slice is 80-odd answers — it offered a
 * personal fit on **9 of 24** review logs generated from the population
 * defaults themselves, data where the only correct answer is "there is nothing
 * to find". The improvements it accepted were all inside one and a bit standard
 * errors of zero (0.0080 ± 0.0121, 0.0090 ± 0.0077, 0.0118 ± 0.0095, 0.0048 ±
 * 0.0105), and some of the vectors it offered were as far from the true weights
 * as a deliberately different learner's.
 *
 * Two things changed, and this file holds both to their measurements:
 *
 *  1. the improvement is now measured **paired, per review, with a standard
 *     error**, and has to clear `mean − 1.645 × SE > 0` against *both*
 *     baselines (`pairedImprovement`, `lib/fsrs-optimize/loss.ts`);
 *  2. `MIN_REVIEWS_FOR_FIT` went from 400 to 1,000, because at 400 even a
 *     correct 5% test is being asked a question the data cannot answer.
 *
 * The experiment below is the reviewer's, shortened enough to live in a unit
 * suite: null logs in, and the two rules scored side by side on the same runs.
 */
import { describe, expect, it } from 'vitest';
import { CLAMP_PARAMETERS, default_w, W17_W18_Ceiling } from 'ts-fsrs';

import {
  buildTrainingSet,
  IMPROVEMENT_Z,
  MIN_REVIEWS_FOR_FIT,
  optimizeWeights,
  pairedImprovement,
  predict,
  type Prediction,
} from '@/lib/fsrs-optimize';
import { normalizedDistance, syntheticReviews } from './synthetic';

/** The search is deterministic, so a test may run it straight through. */
const noYield = async (): Promise<void> => {};
const RANGES = CLAMP_PARAMETERS(W17_W18_Ceiling, true) as [number, number][];

const prediction = (index: number, p: number, recalled: boolean): Prediction => ({
  cardId: 'c',
  index,
  reviewedAt: index,
  p,
  recalled,
});

describe('pairedImprovement', () => {
  it('is the mean of the per-review differences, with the error on that mean', () => {
    // Two reviews, both recalled. The candidate is more confident on the first
    // and less on the second, so the differences are −log(0.8)+log(0.9) and
    // −log(0.6)+log(0.5): one gain, one loss, and a spread between them.
    const baseline = [prediction(0, 0.8, true), prediction(1, 0.6, true)];
    const candidate = [prediction(0, 0.9, true), prediction(1, 0.5, true)];
    const differences = [
      -Math.log(0.8) - -Math.log(0.9),
      -Math.log(0.6) - -Math.log(0.5),
    ];
    const mean = (differences[0] + differences[1]) / 2;
    const variance =
      ((differences[0] - mean) ** 2 + (differences[1] - mean) ** 2) / (differences.length - 1);
    const standardError = Math.sqrt(variance / differences.length);

    const result = pairedImprovement(candidate, baseline);
    expect(result.count).toBe(2);
    expect(result.mean).toBeCloseTo(mean, 12);
    expect(result.standardError).toBeCloseTo(standardError, 12);
    expect(result.lowerBound).toBeCloseTo(mean - IMPROVEMENT_Z * standardError, 12);
  });

  it('never calls a vector identical to the baseline an improvement', () => {
    const same = [prediction(0, 0.8, true), prediction(1, 0.6, false), prediction(2, 0.9, true)];
    const result = pairedImprovement(same, same);
    expect(result.mean).toBe(0);
    expect(result.standardError).toBe(0);
    expect(result.lowerBound).toBe(0);
    // The gate is strictly greater than zero, so this is refused.
    expect(result.lowerBound > 0).toBe(false);
  });

  it('charges a review the candidate could not model at all', () => {
    // A degenerate candidate abandons a card mid-replay, so its prediction is
    // simply missing. Dropping the pair would let refusing to answer look like
    // an improvement; the missing side is charged the worst a prediction costs.
    const baseline = [prediction(0, 0.8, true), prediction(1, 0.8, true)];
    const candidate = [prediction(0, 0.9, true)];
    const result = pairedImprovement(candidate, baseline);
    expect(result.count).toBe(2);
    expect(result.mean).toBeLessThan(0);
  });

  it('windows half-open, like logLoss, so the held-out half is exactly the held-out half', () => {
    const rows = [prediction(10, 0.8, true), prediction(20, 0.8, true), prediction(30, 0.8, true)];
    expect(pairedImprovement(rows, rows, 20, Number.POSITIVE_INFINITY).count).toBe(2);
    expect(pairedImprovement(rows, rows, Number.NEGATIVE_INFINITY, 20).count).toBe(1);
  });

  it('is computed over the same reviews for both vectors', () => {
    // The point of pairing: the difference is taken review by review, so a
    // held-out slice that is hard for everybody cancels out of it.
    const reviews = syntheticReviews({ w: default_w, cards: 30, reviewsPerCard: 6, seed: 77 });
    const set = buildTrainingSet(reviews);
    const a = predict(set, default_w);
    const b = predict(set, default_w.map((value, index) => (index === 4 ? value * 1.3 : value)));
    const paired = pairedImprovement(b, a, set.splitAt, Number.POSITIVE_INFINITY);
    expect(paired.count).toBe(set.heldOutCount);
  });
});

describe('the noise gate', () => {
  /**
   * The reviewer's blocking case, permanently.
   *
   * Twelve review logs generated from the population defaults — the answer is
   * always "nothing to find" — sized just over the *old* floor, run with that
   * old floor so the gate itself is what is being measured. Both rules are
   * scored on the same twelve runs: the old one accepts several, the new one at
   * most one, which is the 5% it advertises.
   */
  it('does not offer noise as a personal fit on a log with nothing in it', async () => {
    const runs = 12;
    let offeredNow = 0;
    let offeredUnderTheOldRule = 0;
    const drifts: number[] = [];

    for (let seed = 100; seed < 100 + runs; seed += 1) {
      const reviews = syntheticReviews({ w: default_w, cards: 60, reviewsPerCard: 8, seed });
      const set = buildTrainingSet(reviews);
      expect(set.scorableReviews).toBeGreaterThan(400);
      expect(set.scorableReviews).toBeLessThan(MIN_REVIEWS_FOR_FIT);

      const result = await optimizeWeights({ reviews, minReviews: 400, yieldTo: noYield });
      // The old rule, recomputed from the numbers this result still reports.
      if (
        result.fittedLoss !== null &&
        result.currentLoss !== null &&
        result.fittedLoss < result.currentLoss
      ) {
        offeredUnderTheOldRule += 1;
      }
      if (result.status === 'ok') {
        offeredNow += 1;
        drifts.push(normalizedDistance(result.w!, [...default_w], RANGES));
      }
      // Whatever it decides, it says how sure it is — and the decision follows
      // that number rather than the sign of a difference.
      if (result.improvementOverCurrent) {
        expect(result.status === 'ok').toBe(result.improvementOverCurrent.lowerBound > 0);
      }
    }

    expect(offeredUnderTheOldRule).toBeGreaterThanOrEqual(3);
    expect(offeredNow).toBeLessThanOrEqual(1);
    expect(offeredNow).toBeLessThan(offeredUnderTheOldRule);
    // And nothing offered is wildly far from the truth, which is what the old
    // rule's worst runs were (0.65 on a scale where a *different* learner is
    // 0.63 away).
    for (const drift of drifts) expect(drift).toBeLessThan(0.4);
  }, 300_000);

  it('refuses to run at all below the floor it now enforces', async () => {
    // ~420 scorable — a month of honest daily study, and still not enough for
    // this to have anything honest to say.
    const reviews = syntheticReviews({ w: default_w, cards: 60, reviewsPerCard: 8, seed: 100 });
    const result = await optimizeWeights({ reviews, yieldTo: noYield });
    expect(MIN_REVIEWS_FOR_FIT).toBe(1000);
    expect(result.reviewCount).toBeLessThan(MIN_REVIEWS_FOR_FIT);
    expect(result.status).toBe('not-enough-data');
    expect(result.fit).toBeNull();
  }, 120_000);

  it('still finds a learner who really is different, and lands nearer the truth', async () => {
    // The other half of the trade: a gate this strict must not refuse a real
    // signal. This learner forms memories twice as slowly and forgets on a
    // flatter curve; the defaults are 0.63 away from them in normalized units.
    const known = default_w.map((value, index) => {
      if (index < 4) return value * 2;
      if (index === 4) return value * 0.75;
      if (index === 5) return value * 1.4;
      if (index === 6) return value * 0.6;
      if (index === 8) return value * 1.6;
      if (index === 9) return value * 0.4;
      if (index === 10) return value * 1.7;
      if (index === 11) return value * 1.5;
      if (index === 20) return 0.3;
      return value;
    });
    const reviews = syntheticReviews({ w: known, cards: 200, reviewsPerCard: 12, seed: 5 });
    expect(buildTrainingSet(reviews).scorableReviews).toBeGreaterThan(MIN_REVIEWS_FOR_FIT);

    const result = await optimizeWeights({ reviews, yieldTo: noYield });
    expect(result.status).toBe('ok');
    expect(result.fit).not.toBeNull();
    expect(result.improvementOverCurrent!.lowerBound).toBeGreaterThan(0);
    expect(result.improvementOverDefaults!.lowerBound).toBeGreaterThan(0);

    const fitted = normalizedDistance(result.w!, known, RANGES);
    const defaults = normalizedDistance([...default_w], known, RANGES);
    expect(fitted).toBeLessThan(defaults);
  }, 300_000);
});
