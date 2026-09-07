import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  /** Right-hand side of the header row: a badge, a count, an action. */
  aside?: ReactNode;
}

export function Card({ title, aside, className, children, ...props }: CardProps) {
  return (
    <section
      className={cn('rounded-xl border border-border bg-surface p-4 sm:p-5', className)}
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
