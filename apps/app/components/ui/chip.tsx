import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * The chip (docs/plans/core.md C1) — a small standing label on a surface, as
 * distinct from `Badge`, which annotates a row of text.
 *
 * It exists because product-decisions §5 asks for two specific ones and neither
 * is a badge: the "AI" mark over a model answer, and the quiet "Dictionary only
 * — offline" chip that is the whole visible face of "no AI is reachable". R9 is
 * the risk that those two states get skipped; a primitive with their names on it
 * is how they stop being a caveat.
 *
 * Tones are the palette's three roles plus warning, never a hex, and every one
 * of them is `bg-<role>-soft text-<role>` — including `practice`, which wore
 * `text-ink` in the first draft and so was the one tone that never showed its
 * own colour. `TabBar` puts `text-practice` on the same ground, so the two
 * would have shipped two treatments of one token pair in one phase.
 *
 * `w-fit` is load-bearing, not tidiness: `inline-flex` alone still stretches to
 * the cross axis inside a `flex-col` parent, which turned §5's "AI" mark — one
 * of the two chips R9 says must not be skipped — into a full-width tinted
 * banner in the gallery's own `thinking` specimen. A primitive has to be
 * layout-robust wherever it is dropped.
 */
export type ChipTone = 'neutral' | 'lookup' | 'practice' | 'new' | 'warning';

/** Exported for the variant-map test — see `button.tsx`'s note. */
export const TONES: Record<ChipTone, string> = {
  neutral: 'border-border bg-surface text-muted',
  lookup: 'border-transparent bg-lookup-soft text-lookup',
  practice: 'border-transparent bg-practice-soft text-practice',
  new: 'border-transparent bg-new-soft text-new',
  warning: 'border-transparent bg-warning-soft text-warning',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  /** A lucide glyph, or nothing. Decorative — the label carries the meaning. */
  icon?: ReactNode;
}

export function Chip({ tone = 'neutral', icon, className, children, ...props }: ChipProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {icon ? (
        <span aria-hidden className="inline-flex items-center">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
