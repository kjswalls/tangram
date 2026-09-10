/**
 * Building a dictionary index **in slices**, so the event loop comes back inside
 * a part rather than only between parts.
 *
 * Why this exists: `lib/dict/warm.ts` builds ~1.2 s of indexes in the background
 * after the banner's probe answers. Node is single-threaded, so every millisecond
 * of that is a millisecond in which nothing else on the instance is served — not
 * another route, not a static file. Yielding between the six parts is not enough:
 * the parts are 150–450 ms each, so a request landing in the wrong one waits most
 * of half a second. Measured before this file existed: six yields across 1209 ms,
 * worst stall 400 ms.
 *
 * The unit of work here is therefore a *slice* of one loop, and every builder is
 * written once, as a generator that yields between slices. The eager getters drive
 * the same generator to completion without yielding (`drain` in `index.ts`), so
 * there is exactly one implementation of each index and a direct caller pays no
 * scheduling cost for the warm-up's benefit.
 *
 * `SLICE` is entries-per-step, not milliseconds: a wall-clock budget would make the
 * shape of the work depend on how loaded the box is, and the point is a bound that
 * holds on the slowest machine too.
 */
import type { SortedIndex } from './index';
import type { EntryId } from './types';

/**
 * Entries per slice.
 *
 * The most expensive loops (`pinyin`, `gloss`) run ~3.5 µs per entry on the build
 * box, so 2048 is ~7 ms of work per step and the cheap ones are under 2 ms.
 * Measured over a whole warm-up: 937 steps, 5 stalls over 10 ms, worst 23–25 ms.
 * That worst one is reproducibly ~90 ms into the `hanzi` build, where two 120k-key
 * Maps are growing, and a ~10 ms GC pause sits inside it — it is allocation, not a
 * slice that is too big. 4096 was tried: 45 stalls over 10 ms for 5% less total
 * work. The trade went to the tighter distribution, since the whole point is the
 * request that lands at the wrong moment.
 */
export const SLICE = 2048;

/**
 * Drive a slice-wise builder to completion, right now, without yielding.
 *
 * This is the eager path — a direct caller reading `index.byGloss` wants the map,
 * not a scheduling policy. The only cost over a plain loop is one generator
 * resumption per slice — ~60 for a 120k-entry part, and nothing measurable.
 */
export function drain(steps: Generator<void>): void {
  let step = steps.next();
  while (!step.done) step = steps.next();
}

/** Ascending by UTF-16 code unit — what `Array#sort()` with no comparator does. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mergeInto<T>(
  out: T[],
  values: readonly T[],
  start: number,
  middle: number,
  end: number,
  compare: (a: T, b: T) => number,
): void {
  let left = start;
  let right = middle;
  let at = start;
  while (left < middle && right < end) {
    // `<= 0` takes the left run first, which is what keeps the sort stable and so
    // makes the result identical to `Array#sort`'s, not merely equivalent.
    out[at++] = compare(values[left], values[right]) <= 0 ? values[left++] : values[right++];
  }
  while (left < middle) out[at++] = values[left++];
  while (right < end) out[at++] = values[right++];
}

/**
 * Sort `values` in place, in bounded steps.
 *
 * A bottom-up merge sort: `Array#sort` each `SLICE`-sized block (a few ms), then
 * merge pairs of runs, one pair per step. It is slower end to end than one call to
 * `Array#sort` — ~2× for 120k strings — and that is the trade being made: this
 * work is off the critical path, and a single 77 ms sort in the middle of it is
 * not.
 *
 * Stable, and with the same comparator it produces the same array `Array#sort`
 * would; `tests/unit/dict/incremental.test.ts` checks that against the real
 * headword lists.
 */
export function* sortInSlices<T>(values: T[], compare: (a: T, b: T) => number): Generator<void> {
  const length = values.length;
  if (length <= SLICE) {
    values.sort(compare);
    return;
  }

  for (let start = 0; start < length; start += SLICE) {
    const block = values.slice(start, Math.min(start + SLICE, length)).sort(compare);
    for (let i = 0; i < block.length; i += 1) values[start + i] = block[i];
    yield;
  }

  // Ping-pong between two buffers so a merge never writes over what it is reading.
  let from: T[] = values;
  let to: T[] = new Array<T>(length);
  for (let width = SLICE; width < length; width *= 2) {
    for (let start = 0; start < length; start += width * 2) {
      const middle = Math.min(start + width, length);
      const end = Math.min(start + width * 2, length);
      if (middle >= end) {
        // A lone trailing run: copy it across so `to` is complete.
        for (let i = start; i < end; i += 1) to[i] = from[i];
      } else {
        mergeInto(to, from, start, middle, end, compare);
      }
      yield;
    }
    const swap = from;
    from = to;
    to = swap;
  }

  if (from !== values) for (let i = 0; i < length; i += 1) values[i] = from[i];
}

/**
 * A `Map` of key → ids as a `SortedIndex`, in bounded steps.
 *
 * The shape both `index.ts` (pinyin) and `search.ts` (headword prefixes) need, and
 * the reason it lives here rather than being a third private copy of `toSorted`.
 */
export function* toSortedInSlices(groups: Map<string, EntryId[]>): Generator<void, SortedIndex> {
  const keys = [...groups.keys()];
  yield* sortInSlices(keys, compareStrings);
  const ids: EntryId[][] = new Array<EntryId[]>(keys.length);
  for (let i = 0; i < keys.length; i += 1) {
    ids[i] = groups.get(keys[i]) as EntryId[];
    if ((i + 1) % SLICE === 0) yield;
  }
  return { keys, ids };
}
