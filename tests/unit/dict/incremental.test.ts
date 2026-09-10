/**
 * The slice-wise primitives behind every index build.
 *
 * `sortInSlices` is a hand-written merge sort standing in for `Array#sort`, which
 * is the one place in this refactor where "in slices" could quietly become "in a
 * different order". So it is checked against `Array#sort` itself, on the real
 * headword list as well as on the shapes that break a merge sort: an odd tail, a
 * length that is not a multiple of the slice, duplicates, and an input short
 * enough to take the single-sort path.
 */
import { describe, expect, it } from 'vitest';

import { compareStrings, drain, SLICE, sortInSlices, toSortedInSlices } from '@/lib/dict/incremental';
import { getDictIndex } from '@/lib/dict/index';
import { requireDictData } from './data-required';

/** Deterministic pseudo-random strings — a seeded LCG, so a failure is reproducible. */
function words(count: number): string[] {
  let seed = 12345;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    // Duplicates on purpose: a stable sort has to keep equal keys in input order.
    out.push(`w${seed % (count / 2 || 1)}`);
  }
  return out;
}

describe('sortInSlices', () => {
  for (const count of [0, 1, SLICE - 1, SLICE, SLICE + 1, SLICE * 2, SLICE * 3 + 7, 50_000]) {
    it(`matches Array#sort for ${count} values`, () => {
      const input = words(count);
      const expected = [...input].sort(compareStrings);
      const actual = [...input];
      drain(sortInSlices(actual, compareStrings));
      expect(actual).toEqual(expected);
    });
  }

  it('yields between slices, and only for inputs worth slicing', () => {
    expect(countSteps(sortInSlices(words(SLICE), compareStrings))).toBe(0);

    const steps = countSteps(sortInSlices(words(50_000), compareStrings));
    // 25 blocks, then ~25 merges over 5 passes: bounded work per step is the
    // whole point, so the count is high by design.
    expect(steps).toBeGreaterThan(40);
  });

  it('is stable: equal keys keep their input order', () => {
    const input = [
      { k: 'b', at: 0 },
      { k: 'a', at: 1 },
      { k: 'b', at: 2 },
      { k: 'a', at: 3 },
    ];
    drain(sortInSlices(input, (x, y) => compareStrings(x.k, y.k)));
    expect(input.map((entry) => entry.at)).toEqual([1, 3, 0, 2]);
  });
});

describe('toSortedInSlices', () => {
  it('reproduces the sorted-map shape on the real headword index', () => {
    requireDictData();
    const index = getDictIndex();
    const map = index.bySimp;

    const built = drainFor(toSortedInSlices(map));
    const expectedKeys = [...map.keys()].sort();
    expect(built.keys).toEqual(expectedKeys);
    expect(built.ids.length).toBe(expectedKeys.length);
    // The ids are the map's own arrays, not copies: 120k arrays cloned per index
    // would be the memory this whole design is trying not to spend.
    expect(built.ids[0]).toBe(map.get(built.keys[0]));
  }, 60_000);
});

/** How many times a builder hands control back. */
function countSteps(gen: Generator<void>): number {
  let steps = 0;
  let step = gen.next();
  while (!step.done) {
    steps += 1;
    step = gen.next();
  }
  return steps;
}

/** `drain`, for a generator that returns a value. */
function drainFor<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
