/**
 * The seven pieces are really a tangram (docs/plans/core.md C8; `wave-zero.md` §7).
 *
 * There is no CI, so the rule that wants enforcement is this file — and the
 * rule here is unusually easy to break without noticing. Seven polygons that
 * *look* like a tangram will render perfectly: the seam a wrong vertex opens is
 * a hairline at 40px, and a piece of the right area but the wrong shape is
 * invisible unless you measure it. The first draft of `tangram-progress.tsx`
 * had two squares and no parallelogram and looked entirely convincing.
 *
 * So: the areas, the side lengths, that the parallelogram is one, and — by
 * sampling — that the seven pieces cover the square exactly once.
 */
import { describe, expect, it } from 'vitest';

import {
  TANGRAM_PIECES,
  TANGRAM_SIDE,
  filledPieces,
  pieceArea,
  progressLabel,
} from '@/components/practice/tangram-progress';

const byKey = (key: string) => TANGRAM_PIECES.find((piece) => piece.key === key)!;
const distance = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Side lengths, in order, rounded to something a comparison can survive. */
function sides(key: string): number[] {
  const points = byKey(key).points;
  return points.map((point, index) => distance(point, points[(index + 1) % points.length]));
}

/** Even-odd point-in-polygon, the same rule an SVG `polygon` fills by. */
function inside(point: [number, number], polygon: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }
  return hit;
}

const SQRT2 = Math.SQRT2;

describe('the seven pieces', () => {
  it('are seven, and named once each', () => {
    expect(TANGRAM_PIECES).toHaveLength(7);
    expect(new Set(TANGRAM_PIECES.map((piece) => piece.key)).size).toBe(7);
  });

  it('are the tangram’s own set of shapes, by area', () => {
    const areas = TANGRAM_PIECES.map((piece) => pieceArea(piece)).sort((a, b) => a - b);
    // Two small (1), one medium + one square + one parallelogram (2), two large (4).
    expect(areas).toEqual([1, 1, 2, 2, 2, 4, 4]);
    expect(areas.reduce((sum, area) => sum + area, 0)).toBe(TANGRAM_SIDE * TANGRAM_SIDE);
  });

  it('have the tangram’s side lengths, which is what the areas alone do not fix', () => {
    // A right isoceles triangle with legs 2√2 and hypotenuse 4 — a full side of
    // the square.
    for (const key of ['large-1', 'large-2']) {
      expect(sides(key).map((side) => side.toFixed(3)).sort()).toEqual(
        [4, 2 * SQRT2, 2 * SQRT2].map((side) => side.toFixed(3)).sort(),
      );
    }
    expect(sides('medium').map((side) => side.toFixed(3)).sort()).toEqual(
      [2, 2, 2 * SQRT2].map((side) => side.toFixed(3)).sort(),
    );
    for (const key of ['small-1', 'small-2']) {
      expect(sides(key).map((side) => side.toFixed(3)).sort()).toEqual(
        [SQRT2, SQRT2, 2].map((side) => side.toFixed(3)).sort(),
      );
    }
    expect(sides('square').map((side) => side.toFixed(3))).toEqual(
      [SQRT2, SQRT2, SQRT2, SQRT2].map((side) => side.toFixed(3)),
    );
  });

  it('include a parallelogram, not a second square', () => {
    // The trap: a four-sided piece of area 2 with every side √2 is a square,
    // because area = √2·√2·sin θ = 2 forces θ = 90°. The rhomboid must have a
    // side of length 2.
    const points = byKey('parallelogram').points;
    expect(points).toHaveLength(4);
    const edge = (i: number, j: number): [number, number] => [
      points[j][0] - points[i][0],
      points[j][1] - points[i][1],
    ];
    // Opposite sides equal and parallel, which is what makes it a parallelogram.
    expect(edge(0, 1)).toEqual(edge(3, 2));
    expect(edge(1, 2)).toEqual(edge(0, 3));
    expect(sides('parallelogram').map((side) => side.toFixed(3)).sort()).toEqual(
      [2, 2, SQRT2, SQRT2].map((side) => side.toFixed(3)).sort(),
    );
    // …and it is NOT a square: two of its sides differ.
    expect(new Set(sides('parallelogram').map((side) => side.toFixed(3))).size).toBe(2);
  });

  it('tile the square exactly once — no gap, no overlap', () => {
    // A deterministic lattice rather than random points, offset off the
    // half-integer grid so no sample lands on a shared edge (where even-odd
    // fill is a coin toss and would report a false gap).
    const STEP = 0.013;
    let uncovered = 0;
    let overlapping = 0;
    let sampled = 0;
    for (let x = STEP / 2; x < TANGRAM_SIDE; x += STEP) {
      for (let y = STEP / 3; y < TANGRAM_SIDE; y += STEP) {
        sampled += 1;
        const hits = TANGRAM_PIECES.filter((piece) => inside([x, y], piece.points)).length;
        if (hits === 0) uncovered += 1;
        if (hits > 1) overlapping += 1;
      }
    }
    expect(sampled).toBeGreaterThan(80_000);
    expect({ uncovered, overlapping }).toEqual({ uncovered: 0, overlapping: 0 });
  });
});

describe('how many pieces are filled', () => {
  it('is empty before the session starts and whole when it ends', () => {
    expect(filledPieces(0, 8)).toBe(0);
    expect(filledPieces(8, 8)).toBe(7);
    expect(filledPieces(9, 8)).toBe(7);
  });

  it('never completes the square early, however the rounding falls', () => {
    // The square completing with cards still to grade is the one failure that
    // would make the whole thing a lie.
    for (let total = 1; total <= 40; total += 1) {
      for (let done = 0; done < total; done += 1) {
        expect(filledPieces(done, total), `${done}/${total}`).toBeLessThan(7);
      }
    }
  });

  it('shows something for the very first grade of a long session', () => {
    // 1 of 30 rounds to zero pieces. A learner who has graded a card and sees
    // nothing has been told the session is not counting them.
    expect(filledPieces(1, 30)).toBe(1);
    expect(filledPieces(1, 100)).toBe(1);
  });

  it('is monotonic — a grade never takes a piece away', () => {
    for (const total of [3, 7, 8, 13, 50]) {
      let previous = 0;
      for (let done = 0; done <= total; done += 1) {
        const filled = filledPieces(done, total);
        expect(filled, `${done}/${total}`).toBeGreaterThanOrEqual(previous);
        previous = filled;
      }
    }
  });

  it('is nothing at all when there is no session', () => {
    expect(filledPieces(0, 0)).toBe(0);
    expect(filledPieces(3, 0)).toBe(0);
    expect(filledPieces(-1, 5)).toBe(0);
  });

  it('half the queue is more than none and less than all', () => {
    // C8's criterion, as arithmetic: the e2e asserts the same thing on screen.
    expect(filledPieces(4, 8)).toBeGreaterThan(filledPieces(0, 8));
    expect(filledPieces(4, 8)).toBeLessThan(7);
  });
});

describe('the text alternative', () => {
  it('says what is happening in plain words, with no jargon and no fractions', () => {
    expect(progressLabel(0, 8)).toBe('0 of 8 done');
    expect(progressLabel(3, 8)).toBe('3 of 8 done');
    expect(progressLabel(8, 8)).toBe('All done');
    expect(progressLabel(0, 0)).toBe('Nothing to practise');
    for (const label of [progressLabel(3, 8), progressLabel(8, 8), progressLabel(0, 0)]) {
      expect(label).not.toMatch(/card|due|interval|review|SRS/i);
    }
  });
});
