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

/** The fit that would be in force after applying `applied`. */
const inForce = (applied: FsrsWeights): FsrsWeights => applied;

describe('the revert slot', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is empty until something is parked in it', () => {
    expect(readPrevious(fit())).toBeUndefined();
  });

  it('tells "the defaults were in force" apart from "there is nothing to revert to"', () => {
    // `null` is a real answer — before this fit, stock FSRS was running — and
    // `undefined` is the absence of one. A Revert button that cannot tell them
    // apart either offers an undo that does nothing or hides one that works.
    const applied = fit();
    rememberPrevious(null, applied.fittedAt);
    expect(readPrevious(inForce(applied))).toBeNull();
    forgetPrevious();
    expect(readPrevious(inForce(applied))).toBeUndefined();
  });

  it('round-trips a stored fit', () => {
    const previous = fit({ fittedAt: Date.UTC(2026, 1, 1) });
    const applied = fit();
    rememberPrevious(previous, applied.fittedAt);
    expect(readPrevious(inForce(applied))).toEqual(previous);
  });

  it('refuses to restore something this build cannot use', () => {
    const applied = fit();
    const stamp = applied.fittedAt;
    localStorage.setItem(
      KEY,
      JSON.stringify({ saved: true, appliedAt: stamp, previous: { w: [1, 2, 3] } }),
    );
    expect(readPrevious(inForce(applied))).toBeUndefined();
    localStorage.setItem(KEY, 'not json at all');
    expect(readPrevious(inForce(applied))).toBeUndefined();
    localStorage.setItem(KEY, JSON.stringify({ nothing: true }));
    expect(readPrevious(inForce(applied))).toBeUndefined();
  });

  /**
   * The reviewer's case, kept: `resetAll()` and `loadDemo()` clear every Dexie
   * table, and this slot is not a Dexie table. Two things now stop it being
   * offered as an undo of a fit that no longer exists — the seed calls
   * `forgetPrevious()`, and the slot is stamped with the `fittedAt` of the fit
   * it was the undo *of*, so it is refused whenever that fit is not in force.
   */
  it('is not offered once the fit it undoes is gone', () => {
    const applied = fit();
    rememberPrevious(null, applied.fittedAt);

    // The wipe: settings comes back with no weights at all.
    expect(readPrevious(null)).toBeUndefined();

    // A different fit — another device, another build — is not this slot's.
    expect(readPrevious(fit({ fittedAt: applied.fittedAt + 1 }))).toBeUndefined();

    // And the fit it was actually parked against still gets its undo.
    expect(readPrevious(inForce(applied))).toBeNull();
  });

  it('refuses a slot parked by a build that did not stamp it', () => {
    localStorage.setItem(KEY, JSON.stringify({ saved: true, previous: null }));
    expect(readPrevious(fit())).toBeUndefined();
  });

  it('survives a browser that refuses storage entirely', () => {
    // Private mode, or cookies blocked: the property access itself throws.
    vi.stubGlobal('localStorage', {
      get getItem(): never {
        throw new Error('denied');
      },
    });
    expect(() => rememberPrevious(fit(), Date.now())).not.toThrow();
    expect(readPrevious(fit())).toBeUndefined();
    expect(() => forgetPrevious()).not.toThrow();
  });
});
