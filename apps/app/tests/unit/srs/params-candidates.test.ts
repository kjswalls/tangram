import { describe, expect, it } from 'vitest';
import { CLAMP_PARAMETERS, default_w, W17_W18_Ceiling } from 'ts-fsrs';

import { DEFAULT_SETTINGS } from '@/lib/db/schema';
import {
  algorithmFor,
  clipWeights,
  DEFAULT_WEIGHTS,
  isValidWeightVector,
  parametersForWeights,
} from '@/lib/srs/params';

/**
 * The candidate-weight path added in Phase 8 (builder A).
 *
 * `buildParameters` resolves the weights off the settings row and refuses a
 * stored fit that has not proved itself — which is correct, and which is why
 * the optimizer cannot use it: a fit cannot prove itself without being scored
 * first. These three exports are the way in for a vector that is not (yet)
 * anybody's setting, and they are held to the same rule: nothing leaves them
 * that `fsrs()` would reject or quietly rewrite.
 */
describe('clipWeights', () => {
  it('leaves a legal vector alone', () => {
    expect(clipWeights(default_w)).toEqual([...default_w]);
  });

  it('pulls an out-of-range weight to the bound rather than passing it on', () => {
    const clamp = CLAMP_PARAMETERS(W17_W18_Ceiling, true);
    const wild = default_w.map(() => 1e6);
    const clipped = clipWeights(wild);
    clipped.forEach((value, index) => {
      expect(value).toBe(clamp[index][1]);
    });

    const negative = clipWeights(default_w.map(() => -1e6));
    negative.forEach((value, index) => {
      expect(value).toBe(clamp[index][0]);
    });
  });

  it('launders NaN, which is the failure ts-fsrs does not report', () => {
    // `generatorParameters` clamps a NaN vector to 0.001 and schedules with it,
    // with nothing a caller can see. Here it comes out valid or not at all.
    const clipped = clipWeights(default_w.map(() => Number.NaN));
    expect(isValidWeightVector(clipped)).toBe(true);
    expect(clipped.every(Number.isFinite)).toBe(true);
  });

  it('falls back to the defaults for a vector of the wrong length', () => {
    expect(clipWeights([1, 2, 3])).toEqual([...DEFAULT_WEIGHTS]);
    expect(clipWeights([])).toEqual([...DEFAULT_WEIGHTS]);
  });

  it('clips against the short-term bounds the settings actually say', () => {
    // `w19`'s floor moves with `enable_short_term`, so clipping under the wrong
    // one produces a vector the scheduler will silently rewrite.
    const low = default_w.map((value, index) => (index === 19 ? 0 : value));
    expect(clipWeights(low, { shortTermSteps: true })[19]).toBe(0.01);
    expect(clipWeights(low, { shortTermSteps: false })[19]).toBe(0);
  });
});

describe('parametersForWeights', () => {
  it('takes the weights from the candidate and everything else from the settings', () => {
    const candidate = default_w.map((value, index) => (index === 8 ? value * 1.5 : value));
    const params = parametersForWeights(candidate, {
      requestRetention: 0.95,
      shortTermSteps: false,
    });
    expect(params.w[8]).toBeCloseTo(candidate[8], 10);
    expect(params.request_retention).toBe(0.95);
    expect(params.enable_short_term).toBe(false);
  });

  it('ignores the stored fit — that column is what it exists to work around', () => {
    const params = parametersForWeights(default_w, {
      fsrsWeights: {
        w: default_w.map((value) => value * 3),
        fittedAt: 0,
        reviewCount: 1,
        heldOutLogLoss: 0,
        baselineLogLoss: 1,
      },
    });
    expect(params.w).toEqual([...default_w]);
  });

  it('defaults the retention and the steps to the settings defaults', () => {
    const params = parametersForWeights(default_w);
    expect(params.request_retention).toBe(DEFAULT_SETTINGS.requestRetention);
    expect(params.enable_short_term).toBe(DEFAULT_SETTINGS.shortTermSteps);
  });
});

describe('algorithmFor', () => {
  it('is the model behind the parameters: the same forgetting curve', () => {
    const params = parametersForWeights(default_w);
    const algorithm = algorithmFor(params);
    // `next_state(null, …)` initialises from a grade, exactly as a first review
    // does, and the initial stability is that rating's own weight.
    const state = algorithm.next_state(null, 0, 3);
    expect(state.stability).toBeCloseTo(params.w[2], 10);
    expect(state.difficulty).toBeGreaterThanOrEqual(1);
    expect(state.difficulty).toBeLessThanOrEqual(10);
  });

  it('answers under the candidate’s weights, not the population’s', () => {
    const slower = clipWeights(default_w.map((value, index) => (index === 2 ? value * 3 : value)));
    const a = algorithmFor(parametersForWeights(default_w)).next_state(null, 0, 3);
    const b = algorithmFor(parametersForWeights(slower)).next_state(null, 0, 3);
    expect(b.stability).toBeGreaterThan(a.stability);
  });
});
