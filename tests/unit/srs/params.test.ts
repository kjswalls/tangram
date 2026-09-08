import { describe, expect, it } from 'vitest';
import { default_w, generatorParameters } from 'ts-fsrs';

import { DEFAULT_SETTINGS, type FsrsWeights } from '@/lib/db/schema';
import { gradeCard, newCard } from '@/lib/srs/card';
import {
  buildParameters,
  clampRetention,
  describeParameters,
  getScheduler,
  isUsableFit,
  isValidWeightVector,
  MAX_REQUEST_RETENTION,
  MIN_REQUEST_RETENTION,
  RETENTION_CHOICES,
  resolveWeights,
} from '@/lib/srs/params';

const NOW = Date.UTC(2026, 2, 3, 9);
const DAY = 86_400_000;

/** A fit that holds up: 21 finite weights, better than the baseline. */
function fit(overrides: Partial<FsrsWeights> = {}): FsrsWeights {
  return {
    w: default_w.map((value) => value * 1.05),
    fittedAt: NOW,
    reviewCount: 1240,
    heldOutLogLoss: 0.31,
    baselineLogLoss: 0.34,
    ...overrides,
  };
}

describe('the defaults this build ships', () => {
  it('runs FSRS with its own short-term steps, undoing v1 deviation', () => {
    expect(DEFAULT_SETTINGS.shortTermSteps).toBe(true);
    const params = buildParameters();
    expect(params.enable_short_term).toBe(true);
    expect(params.learning_steps).toEqual(['1m', '10m']);
    expect(params.relearning_steps).toEqual(['10m']);
    expect(params.request_retention).toBe(0.9);
    expect(params.w).toEqual([...default_w]);
  });

  it('is the same object ts-fsrs would build for itself', () => {
    // The point of the module is that it adds no opinion of its own beyond the
    // three settings columns: everything else is upstream's default.
    const mine = buildParameters();
    const theirs = generatorParameters();
    expect(mine.maximum_interval).toBe(theirs.maximum_interval);
    expect(mine.enable_fuzz).toBe(theirs.enable_fuzz);
    expect(mine.w).toEqual(theirs.w);
  });
});

describe('the weight vector is validated, not trusted', () => {
  it('accepts the three lengths ts-fsrs supports', () => {
    for (const length of [17, 19, 21]) {
      expect(isValidWeightVector(new Array(length).fill(0.5))).toBe(true);
    }
  });

  it('refuses everything else, including the shapes ts-fsrs fails quietly on', () => {
    // A wrong length is swapped for the defaults with only a console warning;
    // a NaN is *clamped to 0.001* and scheduled with. Neither reaches FSRS.
    expect(isValidWeightVector(new Array(20).fill(0.5))).toBe(false);
    expect(isValidWeightVector([])).toBe(false);
    expect(isValidWeightVector(null)).toBe(false);
    expect(isValidWeightVector('0.4,0.6')).toBe(false);
    const withNaN = new Array(21).fill(0.5);
    withNaN[7] = Number.NaN;
    expect(isValidWeightVector(withNaN)).toBe(false);
    const withInfinity = new Array(21).fill(0.5);
    withInfinity[0] = Number.POSITIVE_INFINITY;
    expect(isValidWeightVector(withInfinity)).toBe(false);
  });

  it('falls back to the population defaults when a stored fit is unusable', () => {
    const bad = resolveWeights({ fsrsWeights: fit({ w: [1, 2, 3] }) });
    expect(bad.source).toBe('default');
    expect(bad.rejected).toBe(true);
    expect(bad.w).toEqual([...default_w]);
    expect(buildParameters({ fsrsWeights: fit({ w: [1, 2, 3] }) }).w).toEqual([...default_w]);
  });

  it('keeps a fit only when it beat the defaults on held-out reviews', () => {
    expect(isUsableFit(fit())).toBe(true);
    // Fitted, valid, and no better than the population parameters: that is
    // overfitting, and applying it would be worse than doing nothing.
    expect(isUsableFit(fit({ heldOutLogLoss: 0.34, baselineLogLoss: 0.34 }))).toBe(false);
    expect(isUsableFit(fit({ heldOutLogLoss: 0.4 }))).toBe(false);
    expect(isUsableFit(fit({ heldOutLogLoss: Number.NaN }))).toBe(false);
    expect(isUsableFit(null)).toBe(false);
  });

  it('uses a good fit', () => {
    const resolved = resolveWeights({ fsrsWeights: fit() });
    expect(resolved.source).toBe('optimized');
    expect(resolved.w).toEqual(fit().w);
    expect(buildParameters({ fsrsWeights: fit() }).w).toEqual(fit().w);
  });
});

describe('requestRetention', () => {
  it('is held inside the range the settings control offers', () => {
    expect(clampRetention(0.5)).toBe(MIN_REQUEST_RETENTION);
    expect(clampRetention(1)).toBe(MAX_REQUEST_RETENTION);
    expect(clampRetention(0.85)).toBe(0.85);
    expect(clampRetention(Number.NaN)).toBe(DEFAULT_SETTINGS.requestRetention);
    expect(clampRetention(undefined)).toBe(DEFAULT_SETTINGS.requestRetention);
  });

  it('offers only values inside its own range, including the FSRS default', () => {
    expect(RETENTION_CHOICES).toContain(DEFAULT_SETTINGS.requestRetention);
    for (const choice of RETENTION_CHOICES) {
      expect(choice).toBeGreaterThanOrEqual(MIN_REQUEST_RETENTION);
      expect(choice).toBeLessThanOrEqual(MAX_REQUEST_RETENTION);
    }
  });

  it('shortens intervals as it rises — the whole point of the control', () => {
    const easy = (retention: number) =>
      gradeCard(newCard(NOW), 4, NOW, { requestRetention: retention }).next.due;
    expect(easy(0.97)).toBeLessThan(easy(0.9));
    expect(easy(0.9)).toBeLessThan(easy(0.7));
  });
});

describe('describeParameters', () => {
  it('names the defaults when nothing is fitted', () => {
    expect(describeParameters()).toBe('FSRS defaults');
    expect(describeParameters({ fsrsWeights: null })).toBe('FSRS defaults');
  });

  it('says what a fit was made from, and when', () => {
    expect(describeParameters({ fsrsWeights: fit() })).toBe(
      'Optimized from your 1,240 reviews on 3 Mar',
    );
    expect(describeParameters({ fsrsWeights: fit({ reviewCount: 1 }) })).toContain('1 review on');
  });

  it('does not claim to be optimized when the stored fit was thrown out', () => {
    expect(describeParameters({ fsrsWeights: fit({ w: [0.4] }) })).toBe(
      'FSRS defaults — the saved weights were not usable',
    );
    expect(describeParameters({ fsrsWeights: fit({ heldOutLogLoss: 0.4 }) })).toBe(
      'FSRS defaults — your last fit did not beat them',
    );
  });
});

describe('the scheduler cache', () => {
  it('hands back one instance per parameter set, and a new one when they change', () => {
    const a = getScheduler();
    expect(getScheduler()).toBe(a);
    expect(getScheduler({ requestRetention: DEFAULT_SETTINGS.requestRetention })).toBe(a);
    const b = getScheduler({ shortTermSteps: false });
    expect(b).not.toBe(a);
    expect(getScheduler({ shortTermSteps: false })).toBe(b);
  });

  it('schedules differently through each of them', () => {
    const short = gradeCard(newCard(NOW), 1, NOW, { shortTermSteps: true }).next;
    const long = gradeCard(newCard(NOW), 1, NOW, { shortTermSteps: false }).next;
    expect(short.due - NOW).toBeLessThan(DAY);
    expect(long.due - NOW).toBeGreaterThanOrEqual(DAY);
  });
});
