import { beforeEach, describe, expect, it, vi } from 'vitest';
import { default_w } from 'ts-fsrs';

import type { FsrsWeights } from '@/lib/db/schema';
import { forgetPrevious, readPrevious, rememberPrevious } from '@/lib/fsrs-optimize';

const KEY = 'tangram.fsrs.previous';

const fit = (patch: Partial<FsrsWeights> = {}): FsrsWeights => ({
  w: [...default_w],
  fittedAt: Date.UTC(2026, 2, 3),
  reviewCount: 1240,
  heldOutLogLoss: 0.31,
  baselineLogLoss: 0.34,
  ...patch,
});

describe('the revert slot', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is empty until something is parked in it', () => {
    expect(readPrevious()).toBeUndefined();
  });

  it('tells "the defaults were in force" apart from "there is nothing to revert to"', () => {
    // `null` is a real answer — before this fit, stock FSRS was running — and
    // `undefined` is the absence of one. A Revert button that cannot tell them
    // apart either offers an undo that does nothing or hides one that works.
    rememberPrevious(null);
    expect(readPrevious()).toBeNull();
    forgetPrevious();
    expect(readPrevious()).toBeUndefined();
  });

  it('round-trips a stored fit', () => {
    const previous = fit();
    rememberPrevious(previous);
    expect(readPrevious()).toEqual(previous);
  });

  it('refuses to restore something this build cannot use', () => {
    localStorage.setItem(KEY, JSON.stringify({ saved: true, previous: { w: [1, 2, 3] } }));
    expect(readPrevious()).toBeUndefined();
    localStorage.setItem(KEY, 'not json at all');
    expect(readPrevious()).toBeUndefined();
    localStorage.setItem(KEY, JSON.stringify({ nothing: true }));
    expect(readPrevious()).toBeUndefined();
  });

  it('survives a browser that refuses storage entirely', () => {
    // Private mode, or cookies blocked: the property access itself throws.
    vi.stubGlobal('localStorage', {
      get getItem(): never {
        throw new Error('denied');
      },
    });
    expect(() => rememberPrevious(fit())).not.toThrow();
    expect(readPrevious()).toBeUndefined();
    expect(() => forgetPrevious()).not.toThrow();
  });
});
