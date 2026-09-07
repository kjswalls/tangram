import { describe, expect, it } from 'vitest';

import { newCard } from '@/lib/srs/card';
import { KNOWN_STABILITY_DAYS, knownCardState, wordState } from '@/lib/srs/states';

const review = (stability: number) => ({ state: 2 as const, stability });

describe('wordState', () => {
  it('is new with no card and nothing else known about it', () => {
    expect(wordState({ knownBand: 2 })).toBe('new');
    expect(wordState({ card: null, hskBand: 5, knownBand: 2 })).toBe('new');
  });

  it('is learning while a card is unconsolidated', () => {
    expect(wordState({ card: { state: 0, stability: 0 }, knownBand: 2 })).toBe('learning');
    expect(wordState({ card: { state: 1, stability: 40 }, knownBand: 2 })).toBe('learning');
    expect(wordState({ card: { state: 3, stability: 40 }, knownBand: 2 })).toBe('learning');
    expect(wordState({ card: review(KNOWN_STABILITY_DAYS - 0.01), knownBand: 2 })).toBe('learning');
  });

  it('is known at or above the stability threshold', () => {
    expect(wordState({ card: review(KNOWN_STABILITY_DAYS), knownBand: 2 })).toBe('known');
    expect(wordState({ card: review(400), knownBand: 2 })).toBe('known');
  });

  it('is known when declared known, whatever the card says', () => {
    expect(wordState({ card: review(1), known: true, knownBand: 2 })).toBe('known');
  });

  it('is known at or below the known band', () => {
    expect(wordState({ hskBand: 1, knownBand: 2 })).toBe('known');
    expect(wordState({ hskBand: 2, knownBand: 2 })).toBe('known');
    expect(wordState({ hskBand: 3, knownBand: 2 })).toBe('new');
  });
});

describe('knownCardState', () => {
  it('parks the card in Review, above the threshold and out of the queue', () => {
    const now = Date.UTC(2026, 8, 7, 12);
    const next = knownCardState(newCard(now), now);
    expect(next.state).toBe(2);
    expect(next.stability).toBeGreaterThanOrEqual(KNOWN_STABILITY_DAYS);
    expect(next.due).toBeGreaterThan(now + 300 * 86_400_000);
    expect(next.last_review).toBe(now);
    expect(wordState({ card: next, knownBand: 2 })).toBe('known');
  });

  it('never lowers a card that was already more stable', () => {
    const now = Date.now();
    const strong = { ...newCard(now), state: 2 as const, stability: 900, difficulty: 4 };
    expect(knownCardState(strong, now).stability).toBe(900);
  });
});
