import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * A card: a bordered block on the paper ground (docs/plans/core.md §1, C1).
 *
 * **Bordered, not shadowed.** That is a settled fact about the visual language,
 * not a preference: a shadow on a warm paper ground reads as grime, and the
 * whole page is one sheet of paper with darker-edged pieces on it.
 * `--r-md` (16px) is the card radius in the settled scale — **not**
 * `--radius-md`, which is Tailwind's own theme namespace and re-points every
 * `rounded-*` in the app when an unlayered `:root` declares it (HANDOFF.md, C0).
 */
export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  /** Right-hand side of the header row: a badge, a count, an action. */
  aside?: ReactNode;
}

export function Card({ title, aside, className, children, ...props }: CardProps) {
  return (
    <section
      className={cn(
        'rounded-[var(--r-md)] border border-border bg-surface p-4 sm:p-5',
        className,
      )}
      {...props}
    >
      {(title ?? aside) ? (
        <header className="mb-3 flex items-baseline justify-between gap-3">
          {title ? <h2 className="text-sm font-semibold tracking-wide uppercase">{title}</h2> : null}
          {aside}
        </header>
      ) : null}
      {children}
    </section>
  );
}
