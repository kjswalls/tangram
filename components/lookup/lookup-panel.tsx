import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { CardContext } from '@/lib/types';

/**
 * The lookup panel shell. **Frozen after Phase 0** — Phase 1 fills the body with
 * dictionary results (as `children`) and Phase 4 fills the `ask` slot; neither
 * edits this file, which is what keeps those two worktrees off each other.
 *
 * Deliberately not a client component: it holds no state, so it renders in
 * either tree and both phases can pass whatever they need as elements.
 *
 * The dictionary body and the ask slot are independent by construction: a slow
 * or failing provider leaves the body untouched (§3.4).
 */
export interface LookupPanelProps {
  query: string;
  /** Where the query came from: the sentence, the question, the reader offset. */
  context?: CardContext;
  slots?: { ask?: ReactNode };
  /** The dictionary result body. The placeholder shows when there is none. */
  children?: ReactNode;
  className?: string;
}

export function LookupPanel({ query, context, slots, children, className }: LookupPanelProps) {
  const provenance = context?.sentence ?? context?.question;

  return (
    <section
      data-testid="lookup-panel"
      className={cn('rounded-xl border border-border bg-surface', className)}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="hanzi text-xl font-medium">
          {query || <span className="font-sans text-base text-muted">Nothing looked up yet</span>}
        </h2>
        {context ? <Badge tone="accent">from {context.source}</Badge> : null}
      </header>

      {provenance ? (
        <p className="hanzi border-b border-border px-4 py-2 text-sm text-muted">{provenance}</p>
      ) : null}

      <div data-testid="lookup-body" className="px-4 py-4">
        {children ?? (
          <p className="text-sm text-muted">
            Dictionary results arrive in Phase 1. The panel, its provenance line and the ask slot
            are the contract everything else builds against.
          </p>
        )}
      </div>

      {slots?.ask ? (
        <div data-testid="lookup-ask-slot" className="border-t border-border px-4 py-4">
          {slots.ask}
        </div>
      ) : null}
    </section>
  );
}
