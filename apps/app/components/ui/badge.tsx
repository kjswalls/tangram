import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/**
 * A badge annotates a run of text — an HSK band next to a reading, "variant"
 * next to a gloss. `Chip` is the standing label on a surface; the two are kept
 * apart because §5's "Dictionary only — offline" is a chip and an HSK band is
 * not (docs/plans/core.md C1).
 *
 * `accent` is retained as the name of the jade tone: forty-odd call sites say
 * `tone="accent"` and C7/C8 rewrite those screens. `lookup`, `practice` and
 * `new` are the palette's own names and are what new code should use.
 */
export type BadgeTone = 'neutral' | 'accent' | 'lookup' | 'practice' | 'new' | 'warning';

/** Exported for the variant-map test — see `button.tsx`'s note. */
export const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border text-muted',
  accent: 'border-transparent bg-lookup-soft text-lookup',
  lookup: 'border-transparent bg-lookup-soft text-lookup',
  practice: 'border-transparent bg-practice-soft text-practice',
  new: 'border-transparent bg-new-soft text-new',
  warning: 'border-transparent bg-warning-soft text-warning',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
