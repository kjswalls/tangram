'use client';

/**
 * The seven pieces (docs/plans/core.md C8; `wave-zero.md` §7).
 *
 * product-decisions §11 calls the tangram **the** one playful element in the
 * whole design, and it appeared in no phase of any plan in the set — which is
 * how it was nearly lost. It is the app's name (七巧板, "seven clever pieces")
 * rendered as a progress bar: the pieces fill as a practice session runs, so a
 * finished session is a finished square.
 *
 * Four rules keep it from becoming decoration, and each of them is a line in
 * C8:
 *
 * - **It reads the merged queue.** Seven pieces over the session's *total*
 *   items, so a session of three items does not fill three sevenths and stop.
 * - **It is the only animated element**, and the motion is plain CSS (§7): a
 *   fill transition, nothing that runs when nothing is happening.
 * - **It never appears outside a running session.** The Practice tab's idle
 *   state has no square. The *completion* state does carry one, and that is a
 *   correction the review of C8 forced rather than a loosening: a session whose
 *   queue has momentarily emptied while cards are still coming back is not
 *   over, so its square must show the cards still owed rather than vanish (see
 *   `review-session.tsx`, which passes `graded + returning + deferred.length`).
 *   The rule the line was protecting — no square on a tab nobody is practising
 *   on — is unchanged and `tests/e2e/core/tangram.spec.ts` pins it.
 * - **It carries a text alternative.** A square filling up is not an accessible
 *   progress report, so the group is a `role="progressbar"` with the real
 *   value and max. **If the piece count and the item count disagree the pieces
 *   round; the accessible value does not** — `aria-valuenow` is the item count,
 *   not the piece count.
 *
 * ## The dissection
 *
 * A real tangram, not seven shapes that happen to tile. Over a square of side
 * 4 the pieces are two large triangles (hypotenuse 4, area 4 each), one medium
 * triangle (legs 2, area 2), two small triangles (legs √2, area 1 each), one
 * square (side √2, area 2) and one parallelogram (sides 2 and √2, area 2) —
 * sixteen, exactly.
 *
 * **The parallelogram is the piece a careless dissection gets wrong.** A
 * four-sided piece of area 2 with all sides √2 is a *second square*, not a
 * parallelogram: area = √2·√2·sin θ = 2 forces θ = 90°. The rhomboid has to
 * have a side of length 2, which is why its long edge lies along the square's
 * own bottom edge. The first draft of this file had two squares and no
 * parallelogram and looked entirely convincing.
 *
 * `tests/unit/practice/tangram.test.ts` asserts the areas, the side lengths,
 * that the parallelogram is one, and — by sampling — that the seven pieces
 * cover the square with no gap and no overlap. "Seven polygons that look about
 * right" is what you get if nobody checks.
 *
 * They fill largest-first, so the first grade of a session moves a quarter of
 * the square and the learner can see that it is doing something.
 */
import { cn } from '@/lib/cn';

export interface TangramPiece {
  /** Stable name, used as a test id and in the piece's `<title>`. */
  key: string;
  points: readonly (readonly [number, number])[];
}

/** The square's side, in the SVG's own units. */
export const TANGRAM_SIDE = 4;

/**
 * The seven pieces, in fill order (largest first).
 *
 * Vertices are exact; do not "tidy" them. `(3,3)` is the midpoint of the cut
 * from `(4,2)` to `(2,4)`, and `(1,3)` is the midpoint of the cut from `(0,4)`
 * to `(2,2)`; both are corners of three pieces at once, so a rounded
 * coordinate opens a seam.
 */
export const TANGRAM_PIECES: readonly TangramPiece[] = [
  { key: 'large-1', points: [[0, 0], [4, 0], [2, 2]] },
  { key: 'large-2', points: [[0, 0], [2, 2], [0, 4]] },
  { key: 'medium', points: [[4, 2], [4, 4], [2, 4]] },
  { key: 'parallelogram', points: [[0, 4], [2, 4], [3, 3], [1, 3]] },
  { key: 'square', points: [[2, 2], [3, 1], [4, 2], [3, 3]] },
  { key: 'small-1', points: [[4, 0], [4, 2], [3, 1]] },
  { key: 'small-2', points: [[2, 2], [3, 3], [1, 3]] },
];

/** The shoelace area of a piece, for the test that this is really a tangram. */
export function pieceArea(piece: TangramPiece): number {
  const points = piece.points;
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * How many pieces are filled for `done` of `total` items.
 *
 * Rounding, per C8 — and `done > 0` fills at least one piece, because a learner
 * who has graded a card and sees nothing has been told the session is not
 * counting. `total <= 0` is no session, which is zero rather than seven: an
 * empty square is the honest picture of "nothing to do".
 */
export function filledPieces(done: number, total: number): number {
  if (total <= 0) return 0;
  const clamped = Math.max(0, Math.min(done, total));
  if (clamped === 0) return 0;
  if (clamped >= total) return TANGRAM_PIECES.length;
  return Math.max(1, Math.min(TANGRAM_PIECES.length - 1, Math.round((clamped / total) * TANGRAM_PIECES.length)));
}

/** The plain-English line under the square. No jargon, and no fractions. */
export function progressLabel(done: number, total: number): string {
  if (total <= 0) return 'Nothing to practise';
  if (done >= total) return 'All done';
  return `${done} of ${total} done`;
}

export interface TangramProgressProps {
  /** Items finished in this session. */
  done: number;
  /**
   * Everything this session still owes, finished or not — `done` plus what is
   * left.
   *
   * **Not "what the session started with".** It is read on every render and it
   * moves: grading a card 1 or 2 sends it back into the same session, and
   * `shortTermSteps` defaults true, so most sessions end with a total larger
   * than the one they opened on. A denominator that froze at the opening count
   * would fill the square to seven pieces with cards still coming back, which
   * is the one failure that would make the whole thing a lie. Both call sites
   * compute it from the live queue for that reason.
   */
  total: number;
  className?: string;
}

export function TangramProgress({ done, total, className }: TangramProgressProps) {
  const filled = filledPieces(done, total);
  const label = progressLabel(done, total);
  return (
    <div className={cn('flex items-center gap-3', className)} data-testid="tangram-progress">
      <svg
        viewBox={`0 0 ${TANGRAM_SIDE} ${TANGRAM_SIDE}`}
        className="h-10 w-10 shrink-0"
        role="progressbar"
        aria-valuenow={Math.max(0, Math.min(done, total))}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, total)}
        aria-valuetext={label}
        aria-label="Session progress"
        data-filled={filled}
      >
        {TANGRAM_PIECES.map((piece, index) => (
          <polygon
            key={piece.key}
            data-testid="tangram-piece"
            data-piece={piece.key}
            data-state={index < filled ? 'filled' : 'empty'}
            points={piece.points.map(([x, y]) => `${x},${y}`).join(' ')}
            className={cn(
              'transition-[fill-opacity,fill] duration-500 ease-out',
              index < filled ? 'fill-practice' : 'fill-border',
            )}
            fillOpacity={index < filled ? 1 : 0.35}
            stroke="var(--paper)"
            strokeWidth={0.06}
          />
        ))}
      </svg>
      <span data-testid="tangram-label" className="text-sm text-muted">
        {label}
      </span>
    </div>
  );
}
