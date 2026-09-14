import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * The empty state (docs/plans/core.md C1).
 *
 * Named here rather than improvised per screen because one of its uses is load
 * bearing: product-decisions §5's "nothing verifiable" answer is an
 * `EmptyState`, **not an empty answer body** — the difference between the model
 * saying nothing useful and grounding rejecting everything it said. C7 builds
 * that one; this is the shape it is built from.
 */
export interface EmptyStateProps {
  title: ReactNode;
  children?: ReactNode;
  /** Decorative; the title carries the meaning. */
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function EmptyState({
  title,
  children,
  icon,
  action,
  className,
  'data-testid': testId = 'empty-state',
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col items-center gap-2 rounded-[var(--r-md)] border border-dashed border-border',
        'px-4 py-8 text-center',
        className,
      )}
    >
      {icon ? (
        <span aria-hidden className="text-muted">
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? <div className="max-w-prose text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
