import { describe, expect, it } from 'vitest';
import { default_w, forgetting_curve } from 'ts-fsrs';

import { buildTrainingSet, logLoss, predict, scoreWeights, trainLoss } from '@/lib/fsrs-optimize';
import { parametersForWeights } from '@/lib/srs/params';
import { syntheticReviews } from './synthetic';

const LN2 = Math.log(2);

describe('logLoss', () => {
  it('is the mean binary cross-entropy', () => {
    const half = logLoss([
      { reviewedAt: 1, p: 0.5, recalled: true },
      { reviewedAt: 2, p: 0.5, recalled: false },
    ]);
    expect(half.count).toBe(2);
    expect(half.loss).toBeCloseTo(LN2, 12);

    const confident = logLoss([
      { reviewedAt: 1, p: 0.9, recalled: true },
      { reviewedAt: 2, p: 0.9, recalled: false },
    ]);
    expect(confident.loss).toBeCloseTo((-Math.log(0.9) - Math.log(0.1)) / 2, 12);
  });

  it('scores a window half-open, so consecutive windows tile', () => {
    const predictions = [
      { reviewedAt: 10, p: 0.5, recalled: true },
      { reviewedAt: 20, p: 0.5, recalled: true },
      { reviewedAt: 30, p: 0.5, recalled: true },
    ];
    expect(logLoss(predictions, 10, 20).count).toBe(1);
    expect(logLoss(predictions, 20, Number.POSITIVE_INFINITY).count).toBe(2);
    expect(
      logLoss(predictions, Number.NEGATIVE_INFINITY, 20).count +
        logLoss(predictions, 20, Number.POSITIVE_INFINITY).count,
    ).toBe(3);
  });

  it('is infinite rather than NaN when there is nothing to score', () => {
    // `Infinity` loses every comparison, which is what a candidate that
    // predicted nothing deserves. `NaN` would win every one of them silently.
    expect(logLoss([]).loss).toBe(Number.POSITIVE_INFINITY);
    expect(logLoss([{ reviewedAt: 1, p: 0.5, recalled: true }], 100, 200).count).toBe(0);
  });
});

describe('predict', () => {
  it('predicts every scorable review and no others', () => {
    const reviews = syntheticReviews({ w: default_w, cards: 25, reviewsPerCard: 5, seed: 12 });
    const set = buildTrainingSet(reviews);
    expect(predict(set, default_w)).toHaveLength(set.scorableReviews);
  });

  it('uses ts-fsrs’s own forgetting curve, not a re-derivation of it', () => {
    // One card, two reviews: the second's prediction must be exactly what
    // `forgetting_curve` says about the state the first grade initialised.
    const reviews = syntheticReviews({ w: default_w, cards: 1, reviewsPerCard: 2, seed: 31 });
    const set = buildTrainingSet(reviews);
    const [prediction] = predict(set, default_w);
    const params = parametersForWeights(default_w);
    const first = set.cards[0][0];
    const second = set.cards[0][1];
    // The state after the first grade is the initial stability for that rating.
    const stability = params.w[first.rating - 1];
    expect(prediction.p).toBeCloseTo(
      forgetting_curve(params.w, second.elapsedDays, stability),
      10,
    );
    expect(prediction.recalled).toBe(second.rating !== 1);
  });

  it('treats Again as forgotten and every other rating as recalled', () => {
    const reviews = syntheticReviews({ w: default_w, cards: 30, reviewsPerCard: 5, seed: 8 });
    const set = buildTrainingSet(reviews);
    const scorable = set.cards.flat().filter((entry) => entry.scorable);
    const predictions = predict(set, default_w);
    expect(predictions.map((p) => p.recalled)).toEqual(
      scorable.map((entry) => entry.rating !== 1),
    );
  });

  it('replays a same-day review without scoring it', () => {
    // Its state update still happens — the short-term stability path is how a
    // learning step moves the card — but it contributes nothing to the loss.
    const reviews = syntheticReviews({ w: default_w, cards: 20, reviewsPerCard: 5, seed: 44 });
    const withSameDay = reviews.map((row, index) =>
      index % 4 === 1 ? { ...row, log: { ...row.log, elapsed_days: 0 } } : row,
    );
    const set = buildTrainingSet(withSameDay);
    const scored = set.cards.flat().filter((entry) => entry.scorable);
    expect(scored.length).toBeLessThan(
      set.cards.flat().filter((entry, index) => index > 0).length,
    );
    expect(predict(set, default_w)).toHaveLength(scored.length);
  });

  it('never returns a probability of exactly 0 or 1', () => {
    // An unclamped certainty makes one review's log-loss infinite and every
    // comparison after it NaN-poisoned.
    const reviews = syntheticReviews({ w: default_w, cards: 40, reviewsPerCard: 8, seed: 2 });
    const set = buildTrainingSet(reviews);
    for (const prediction of predict(set, default_w)) {
      expect(prediction.p).toBeGreaterThan(0);
      expect(prediction.p).toBeLessThan(1);
      expect(Number.isFinite(prediction.p)).toBe(true);
    }
  });

  it('scores a wrong-length or NaN weight vector instead of crashing on it', () => {
    const reviews = syntheticReviews({ w: default_w, cards: 20, reviewsPerCard: 5, seed: 6 });
    const set = buildTrainingSet(reviews);
    // Both fall back to the defaults inside `clipWeights`, so they score as the
    // defaults do — finite, comparable, and never `NaN`.
    for (const bad of [[1, 2, 3], default_w.map(() => Number.NaN)]) {
      const score = trainLoss(set, bad);
      expect(Number.isFinite(score)).toBe(true);
    }
  });
});

describe('scoreWeights', () => {
  it('splits the score at the training boundary and nowhere else', () => {
    const reviews = syntheticReviews({ w: default_w, cards: 60, reviewsPerCard: 6, seed: 19 });
    const set = buildTrainingSet(reviews);
    const score = scoreWeights(set, default_w);
    expect(score.train.count).toBe(set.trainCount);
    expect(score.heldOut.count).toBe(set.heldOutCount);
    expect(score.train.count + score.heldOut.count).toBe(set.scorableReviews);
    expect(trainLoss(set, default_w)).toBeCloseTo(score.train.loss, 12);
  });

  it('gives the weights the log was generated from a lower loss than a wrong set', () => {
    // The sanity check under everything else: the objective has to be able to
    // tell the true model from a plainly wrong one, or nothing above it means
    // anything.
    const reviews = syntheticReviews({ w: default_w, cards: 80, reviewsPerCard: 8, seed: 21 });
    const set = buildTrainingSet(reviews);
    const wrong = default_w.map((value, index) => (index < 4 ? value * 8 : value));
    expect(scoreWeights(set, default_w).heldOut.loss).toBeLessThan(
      scoreWeights(set, wrong).heldOut.loss,
    );
  });
});
