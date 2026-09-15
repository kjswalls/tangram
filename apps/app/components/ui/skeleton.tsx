import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/**
 * A placeholder block while something is in flight (docs/plans/core.md C1).
 *
 * `aria-hidden` and not `role="status"`: a skeleton is the *absence* of content
 * and announcing it says nothing. The surface that owns the wait owns the live
 * region.
 *
 * The pulse is plain CSS and respects `prefers-reduced-motion` (§7 allows CSS
 * and View Transitions and no animation library; C8's tangram pieces are the
 * only element that is meant to be noticed moving).
 *
 * It paints in `--skeleton`, not a wash of `--border`: at 60% of the border
 * token it measured 1.26:1 against a card and was at the edge of perceivable —
 * and the place it matters most is the ask panel's `thinking` state, where
 * these rows are the only evidence that the model is working.
 */
export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      data-testid="skeleton"
      className={cn(
        'animate-pulse rounded-[var(--r-sm)] bg-skeleton motion-reduce:animate-none',
        'h-4 w-full',
        className,
      )}
      {...props}
    />
  );
}
