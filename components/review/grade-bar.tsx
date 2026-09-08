import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { StoredRating } from '@/lib/db/schema';
import type { GradeOption } from '@/lib/srs/session';

/**
 * Again · Hard · Good · Easy, each carrying the interval it would schedule
 * (PLAN.md §3.3) and bound to its number key. The interval comes from
 * `fsrs.repeat()` on the card's real state, so the button says what pressing it
 * will actually do rather than a fixed guess.
 *
 * `suggested` is free-recall grading's whole footprint here (Phase 6 item 2):
 * it rings one button and marks it `data-suggested`. It cannot press it — the
 * bar still only grades from a click or a key, which is the rule that feature
 * is built around.
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
          disabled={disabled}
          aria-keyshortcuts={String(option.rating)}
          className={cn(
            'h-auto flex-col gap-0.5 py-2',
            option.rating === suggested && 'ring-2 ring-accent',
          )}
          onClick={() => onGrade(option.rating)}
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="text-xs opacity-60">
              {option.rating}
            </span>
            {option.label}
          </span>
          <span className="text-xs font-normal opacity-80">{option.interval}</span>
        </Button>
      ))}
    </div>
  );
}
