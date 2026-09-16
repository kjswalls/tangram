import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { StoredRating } from '@/lib/db/schema';
import type { GradeOption } from '@/lib/srs/session';

/**
 * Forgot it · Barely remembered · Got it · Instant (docs/plans/core.md C8),
 * each carrying the interval it would schedule (PLAN.md §3.3) and bound to its
 * number key. The interval comes from `fsrs.repeat()` on the card's real state,
 * so the button says what pressing it will actually do rather than a fixed
 * guess — which is why C8 relabels the buttons and leaves the subtitles alone.
 *
 * **There is no coaching line.** "Be honest with yourself" and its relatives
 * were explicitly rejected: a learner pressing one of four buttons does not
 * need to be told how to feel about it, and the line was the most-read text on
 * the busiest screen in the app.
 *
 * "Got it" is the **only filled button on the screen** — the single primary
 * action, in the practice accent (§1 assigns vermillion to Practice, so
 * `variant="primary"` is already that colour; C8 asks for vermillion and the
 * palette already agreed).
 *
 * `suggested` is free-recall grading's whole footprint here (Phase 6 item 2):
 * it rings one button, writes the word under it, and marks it `data-suggested`.
 * It cannot press it — the bar still only grades from a click or a key, which
 * is the rule that feature is built around.
 *
 * The ring has an **offset** and the word is there because of one case: Good is
 * the primary button, filled `bg-accent`, and a `ring-accent` drawn flat on it
 * is the same colour on the same pixel — invisible. A suggestion of 3 is a
 * common suggestion (it is what a right-but-differently-worded answer scores),
 * so a cue that disappears for one rating in four is a cue that cannot be
 * relied on. The word is also the non-colour half of the cue, for a learner who
 * would not see a teal ring at all.
 */
export function GradeBar({
  options,
  disabled,
  suggested = null,
  onGrade,
}: {
  options: GradeOption[];
  disabled?: boolean;
  suggested?: StoredRating | null;
  onGrade: (rating: StoredRating) => void;
}) {
  return (
    <div data-testid="grade-bar" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {options.map((option) => (
        <Button
          key={option.rating}
          data-testid={`grade-${option.rating}`}
          data-interval={option.interval}
          data-suggested={option.rating === suggested ? 'true' : undefined}
          variant={option.rating === 3 ? 'primary' : 'secondary'}
          size="lg"
          /*
            **The shape, not a copy of it** (core.md C8's review). `shape="grade"`
            exists so the two-line auto-height layout lives in one place, and
            this bar was still hand-rolling `h-auto flex-col gap-0.5 …` — so the
            gallery's `shape="grade"` row showed a button the app did not render,
            and a regression in either could not be seen from the other. The
            interval goes through `sub`, which is what `sub` is for.
          */
          shape="grade"
          sub={option.interval}
          disabled={disabled}
          aria-keyshortcuts={String(option.rating)}
          className={cn(
            // The `px-2`/`py-2` override is C8's doing: "Barely remembered" is
            // two words longer than "Hard" and on a 390px phone the 2×2 grid
            // gives each button about 170px. It wraps to two lines and must
            // stay un-clipped rather than pushing the grid wider than the
            // viewport. The centring and the column come from the shape.
            'px-2 py-2',
            option.rating === suggested &&
              'ring-2 ring-accent ring-offset-2 ring-offset-background',
          )}
          onClick={() => onGrade(option.rating)}
        >
          <span className="flex min-w-0 items-center justify-center gap-1.5">
            <span aria-hidden className="shrink-0 text-xs opacity-60">
              {option.rating}
            </span>
            <span className="min-w-0">{option.label}</span>
          </span>
          {/*
            Above the interval rather than below it, which is where the
            hand-rolled version put it: `sub` is always the button's last line,
            and the cue belongs next to the label it is a cue for.
          */}
          {option.rating === suggested ? (
            <span
              data-testid="grade-suggested-note"
              className="text-[0.625rem] font-semibold tracking-wide uppercase"
            >
              suggested
            </span>
          ) : null}
        </Button>
      ))}
    </div>
  );
}
