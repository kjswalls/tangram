import { describe, expect, it, vi } from 'vitest';
import { CLAMP_PARAMETERS, default_w, W17_W18_Ceiling } from 'ts-fsrs';

import { MIN_REVIEWS_FOR_FIT, optimizeWeights } from '@/lib/fsrs-optimize';
import { clipWeights, isUsableFit, isValidWeightVector, resolveWeights } from '@/lib/srs/params';
import { syntheticReviews } from './synthetic';

const DAY = 86_400_000;
/** The search is deterministic, so a test may run it straight through. */
const noYield = async (): Promise<void> => {};

/**
 * Distance between two weight vectors in *relative* units: each weight measured
 * against its own magnitude, floored so a weight that is near zero does not
 * dominate. Raw L2 would be meaningless — `w0..w3` are days and run to 100,
 * `w12` is a damping term that tops out at 0.25.
 */
function relativeDistance(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < b.length; i += 1) {
    const scale = Math.max(Math.abs(b[i]), 0.05);
    total += ((a[i] - b[i]) / scale) ** 2;
  }
  return Math.sqrt(total / b.length);
}

/**
 * A learner unlike the population: slower to form memories at first (the
 * initial stabilities), less put off by difficulty, and with a flatter
 * forgetting curve. Clipped, so it is a set of weights ts-fsrs would accept.
 */
const KNOWN = clipWeights(
  default_w.map((value, index) => {
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
  }),
);

describe('the safety rule', () => {
  it('refuses a log below the floor, whatever is in it', async () => {
    const reviews = syntheticReviews({ w: KNOWN, cards: 4, reviewsPerCard: 5, seed: 2 });
    expect(reviews).toHaveLength(20);

    const result = await optimizeWeights({ reviews, yieldTo: noYield });
    expect(result.status).toBe('not-enough-data');
    expect(result.fit).toBeNull();
    expect(result.w).toBeNull();
    expect(result.reviewCount).toBeLessThan(MIN_REVIEWS_FOR_FIT);
    // Nothing was scored, so nothing may be claimed about the scores.
    expect(result.fittedLoss).toBeNull();
    expect(result.currentLoss).toBeNull();
  });

  it('refuses a log the population defaults already explain', async () => {
    // Generated *from* `default_w`, so the true model is the one already in
    // force and there is nothing to find. Anything the search gains on the
    // training half is overfitting by construction, and the held-out half is
    // what catches it.
    const reviews = syntheticReviews({ w: default_w, cards: 300, reviewsPerCard: 10, seed: 11 });
    const result = await optimizeWeights({ reviews, yieldTo: noYield });

    expect(result.status).toBe('no-improvement');
    expect(result.fit).toBeNull();
    expect(result.fittedLoss).toBeGreaterThanOrEqual(result.currentLoss!);
    // The candidate is still reported — the panel says "we looked and found
    // nothing", which is a different sentence from "we did not look".
    expect(result.w).not.toBeNull();
  });

  it('refuses a fit that chased noise: it fires on the held-out half, not the training one', async () => {
    // The training half is ratings drawn at random — a history with no relation
    // between how long a card was left and whether it came back. The held-out
    // half is a real FSRS history. A fit made on the first cannot help on the
    // second, and the gate is the only thing standing between the learner and
    // months of a schedule fitted to noise.
    const noise = syntheticReviews({
      w: default_w,
      cards: 200,
      reviewsPerCard: 8,
      seed: 3,
      noise: true,
      idPrefix: 'noise',
      startAt: Date.UTC(2024, 0, 1),
    });
    const real = syntheticReviews({
      w: default_w,
      cards: 60,
      reviewsPerCard: 8,
      seed: 103,
      idPrefix: 'real',
      startAt: Date.UTC(2024, 0, 1) + 900 * DAY,
    });
    const reviews = [...noise, ...real].sort((a, b) => a.reviewedAt - b.reviewedAt);

    const result = await optimizeWeights({ reviews, yieldTo: noYield });
    expect(result.status).toBe('no-improvement');
    expect(result.fit).toBeNull();
    expect(result.fittedLoss).toBeGreaterThan(result.currentLoss!);
  });

  it('never applies anything: the result is a proposal', async () => {
    const result = await recoveryFit();
    expect(result.status).toBe('ok');
    // The weights in force are still the defaults; the fit is a value the
    // caller may choose to write.
    expect(resolveWeights(null).source).toBe('default');
    expect(result.fit).not.toBeNull();
    // And what it hands back is a fit `lib/srs/params.ts` will actually accept.
    expect(isUsableFit(result.fit)).toBe(true);
  });
});

/**
 * One fit, shared by the three assertions about it. The search is hundreds of
 * full replays of a two-thousand-review log; running it three times to ask
 * three questions about the same answer is a slow suite for nothing.
 */
let recovered: Awaited<ReturnType<typeof optimizeWeights>> | undefined;
async function recoveryFit() {
  recovered ??= await optimizeWeights({
    reviews: syntheticReviews({ w: KNOWN, cards: 250, reviewsPerCard: 8, seed: 7 }),
    yieldTo: noYield,
  });
  return recovered;
}

describe('the fit itself', () => {
  it('recovers weights closer to the ones the log came from than the defaults are', async () => {
    // The question the optimizer exists to answer. The history below was
    // generated by a learner whose parameters are known; a fit that is no
    // closer to them than stock FSRS is has learnt nothing.
    const result = await recoveryFit();

    expect(result.status).toBe('ok');
    const fitted = relativeDistance(result.w!, KNOWN);
    const defaults = relativeDistance([...default_w], KNOWN);
    expect(fitted).toBeLessThan(defaults);
    // And it beats them where it counts, on reviews it never saw.
    expect(result.fittedLoss).toBeLessThan(result.currentLoss!);
    expect(result.fittedLoss).toBeLessThan(result.defaultLoss!);
  }, 60_000);

  it('reports a fit that params.ts will apply, and counts what it was fitted on', async () => {
    const result = await recoveryFit();

    const fit = result.fit!;
    expect(isValidWeightVector(fit.w)).toBe(true);
    expect(fit.w).toHaveLength(default_w.length);
    expect(fit.reviewCount).toBe(result.reviewCount);
    expect(fit.heldOutLogLoss).toBe(result.fittedLoss);
    expect(fit.baselineLogLoss).toBe(result.defaultLoss);
    expect(fit.fittedAt).toBeGreaterThan(0);
    // Train and held-out are the whole of the scorable log and nothing else.
    expect(result.trainCount + result.heldOutCount).toBe(result.reviewCount);
    expect(result.reviewCount).toBeLessThan(result.totalReviews);
  }, 60_000);

  it('stays inside the bounds ts-fsrs itself clamps to', async () => {
    const result = await recoveryFit();
    const clamp = CLAMP_PARAMETERS(W17_W18_Ceiling, true);
    result.w!.forEach((value, index) => {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(clamp[index][0]);
      expect(value).toBeLessThanOrEqual(clamp[index][1]);
    });
  }, 60_000);
});

describe('degenerate logs', () => {
  // A learner who fails everything, and one who finds everything easy. Neither
  // is a reason to produce `NaN`, an unclamped weight, or a crash.
  for (const [rating, name] of [
    [1, 'every review Again'],
    [4, 'every review Easy'],
  ] as const) {
    it(`survives ${name}`, async () => {
      const reviews = syntheticReviews({
        w: default_w,
        cards: 150,
        reviewsPerCard: 10,
        seed: 5,
        fixedRating: rating,
      });
      const result = await optimizeWeights({ reviews, yieldTo: noYield });

      expect(['ok', 'no-improvement']).toContain(result.status);
      expect(result.w!.every(Number.isFinite)).toBe(true);
      expect(isValidWeightVector(result.w)).toBe(true);
      expect(Number.isFinite(result.fittedLoss!)).toBe(true);
      expect(Number.isFinite(result.currentLoss!)).toBe(true);
      const clamp = CLAMP_PARAMETERS(W17_W18_Ceiling, true);
      result.w!.forEach((value, index) => {
        expect(value).toBeGreaterThanOrEqual(clamp[index][0]);
        expect(value).toBeLessThanOrEqual(clamp[index][1]);
      });
      if (result.fit) expect(isUsableFit(result.fit)).toBe(true);
    }, 60_000);
  }
});

describe('running it without freezing the browser', () => {
  it('yields between chunks and reports progress that only moves forward', async () => {
    const reviews = syntheticReviews({ w: KNOWN, cards: 60, reviewsPerCard: 8, seed: 13 });
    const yielded = vi.fn(async () => {});
    const progress: number[] = [];
    let total = 0;

    await optimizeWeights({
      reviews,
      minReviews: 10,
      yieldEvery: 4,
      yieldTo: yielded,
      onProgress: (update) => {
        progress.push(update.done);
        total = update.total;
      },
    });

    expect(yielded.mock.calls.length).toBeGreaterThan(5);
    expect(progress.length).toBeGreaterThan(5);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress[progress.length - 1]).toBe(total);
  }, 60_000);

  it('stops when the caller cancels, and returns nothing rather than half a fit', async () => {
    const reviews = syntheticReviews({ w: KNOWN, cards: 60, reviewsPerCard: 8, seed: 13 });
    const controller = new AbortController();
    let seen = 0;

    const result = await optimizeWeights({
      reviews,
      minReviews: 10,
      yieldEvery: 1,
      yieldTo: noYield,
      signal: controller.signal,
      onProgress: () => {
        seen += 1;
        if (seen === 3) controller.abort();
      },
    });

    expect(result.status).toBe('cancelled');
    expect(result.fit).toBeNull();
    expect(result.w).toBeNull();
    // It stopped early rather than running to the end and throwing the answer
    // away: the search is hundreds of full replays of the log.
    expect(seen).toBeLessThan(30);
  }, 60_000);

  it('is cancelled before it starts if the signal is already aborted', async () => {
    const reviews = syntheticReviews({ w: KNOWN, cards: 60, reviewsPerCard: 8, seed: 13 });
    const result = await optimizeWeights({
      reviews,
      minReviews: 10,
      signal: AbortSignal.abort(),
      yieldTo: noYield,
    });
    expect(result.status).toBe('cancelled');
    expect(result.evaluations).toBe(0);
  });
});
